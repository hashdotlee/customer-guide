/**
 * AIService - Dịch vụ phân tích bài đăng Facebook bằng AI
 * Hỗ trợ: OpenAI (gpt-4o), Anthropic (claude-sonnet-4-6), Google Gemini (gemini-1.5-pro), Cloud endpoint tùy chỉnh
 */

const PROVIDERS = {
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic',
  GEMINI: 'gemini',
  CLOUD: 'cloud',
};

// ─── System prompts (Vietnamese) ──────────────────────────────────────────────

const SYSTEM_PROMPT_ANALYZE = `Bạn là trợ lý phân tích bài đăng bán hàng Facebook chuyên nghiệp.
Nhiệm vụ của bạn là đọc nội dung bài đăng (và ảnh nếu có) rồi trích xuất thông tin sản phẩm một cách chính xác.

Hãy trả lời CHÍNH XÁC theo định dạng JSON sau (không thêm text ngoài JSON):
{
  "title": "Tên sản phẩm ngắn gọn, rõ ràng",
  "price": "Giá hiển thị (ví dụ: 500.000 VND hoặc 50 USD)",
  "priceNumber": 500000,
  "currency": "VND",
  "condition": "Mới | Như mới | Đã qua sử dụng | Cũ | Không rõ",
  "description": "Mô tả chi tiết sản phẩm",
  "category": "Danh mục sản phẩm (ví dụ: Điện tử, Thời trang, Nội thất, ...)",
  "keyFeatures": ["Đặc điểm nổi bật 1", "Đặc điểm nổi bật 2"],
  "estimatedValue": null
}

Lưu ý:
- priceNumber phải là số nguyên hoặc null nếu không xác định được
- estimatedValue là giá trị ước tính thị trường (số nguyên hoặc null)
- Nếu không tìm thấy thông tin, hãy để giá trị null hoặc chuỗi rỗng
- Không thêm giải thích hay văn bản ngoài JSON`;

const SYSTEM_PROMPT_COMPARE = `Bạn là trợ lý so sánh sản phẩm mua sắm chuyên nghiệp.
Nhiệm vụ của bạn là so sánh các sản phẩm và đưa ra đánh giá khách quan giúp người dùng quyết định mua hàng.

Hãy trả lời CHÍNH XÁC theo định dạng JSON sau (không thêm text ngoài JSON):
{
  "summary": "Tóm tắt tổng quan về các sản phẩm được so sánh",
  "rankings": [
    {
      "id": "product-id",
      "pros": ["Ưu điểm 1", "Ưu điểm 2"],
      "cons": ["Nhược điểm 1"],
      "score": 85
    }
  ],
  "recommendation": "Lời khuyên cụ thể nên mua sản phẩm nào và lý do tại sao"
}

Lưu ý:
- score là điểm đánh giá tổng thể từ 0-100
- rankings phải được sắp xếp theo thứ tự điểm từ cao xuống thấp
- Không thêm giải thích hay văn bản ngoài JSON`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Trích xuất JSON từ response text (đề phòng model trả thêm markdown code fence).
 * @param {string} text
 * @returns {Object}
 */
function parseJSONResponse(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('Phản hồi AI trống hoặc không hợp lệ.');
  }

  // Thử parse trực tiếp
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed);
  }

  // Trích xuất từ code fence ```json ... ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    return JSON.parse(fenceMatch[1].trim());
  }

  // Tìm JSON object/array bất kỳ trong text
  const jsonMatch = trimmed.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) {
    return JSON.parse(jsonMatch[1]);
  }

  throw new Error('Không thể trích xuất JSON từ phản hồi AI.');
}

/**
 * Xây dựng nội dung user message từ postData.
 * @param {Object} postData
 * @returns {string}
 */
function buildPostText(postData) {
  const parts = [];

  if (postData.title) parts.push(`Tiêu đề: ${postData.title}`);
  if (postData.rawText) parts.push(`Nội dung bài đăng:\n${postData.rawText}`);
  if (postData.price) parts.push(`Giá đăng: ${postData.price}`);
  if (postData.sellerName) parts.push(`Người bán: ${postData.sellerName}`);
  if (postData.url) parts.push(`URL: ${postData.url}`);

  return parts.join('\n\n') || 'Không có nội dung bài đăng.';
}

/**
 * Lọc URL ảnh hợp lệ (http/https) và giới hạn số lượng.
 * @param {string[]} images
 * @param {number} limit
 * @returns {string[]}
 */
function sanitizeImages(images, limit = 4) {
  if (!Array.isArray(images)) return [];
  return images
    .filter((url) => typeof url === 'string' && /^https?:\/\//i.test(url))
    .slice(0, limit);
}

// ─── AIService class ───────────────────────────────────────────────────────────

export class AIService {
  #provider;
  #apiKey;
  #cloudEndpoint;

  /**
   * @param {Object} settings
   * @param {'openai'|'anthropic'|'gemini'|'cloud'} settings.provider
   * @param {string} settings.apiKey
   * @param {string} [settings.cloudEndpoint]
   */
  constructor(settings = {}) {
    this.#provider = settings.provider ?? PROVIDERS.OPENAI;
    this.#apiKey = settings.apiKey ?? '';
    this.#cloudEndpoint = settings.cloudEndpoint ?? '';
  }

  /**
   * Cập nhật cài đặt dịch vụ.
   * @param {Object} settings
   */
  updateSettings(settings = {}) {
    if (settings.provider !== undefined) this.#provider = settings.provider;
    if (settings.apiKey !== undefined) this.#apiKey = settings.apiKey;
    if (settings.cloudEndpoint !== undefined)
      this.#cloudEndpoint = settings.cloudEndpoint;
  }

  /**
   * Kiểm tra xem dịch vụ đã được cấu hình đúng chưa.
   * @returns {boolean}
   */
  isConfigured() {
    if (this.#provider === PROVIDERS.CLOUD) {
      return Boolean(this.#apiKey && this.#cloudEndpoint);
    }
    return Boolean(this.#apiKey);
  }

  // ─────────────────────────────────────────────
  //  PUBLIC API
  // ─────────────────────────────────────────────

  /**
   * Phân tích bài đăng Facebook và trả về thông tin sản phẩm có cấu trúc.
   * @param {Object} postData - { title, rawText, price, sellerName, url, images[] }
   * @returns {Promise<AnalyzedProduct|null>}
   */
  async analyzePost(postData) {
    if (!this.isConfigured()) {
      console.warn('[AIService] Chưa cấu hình API key.');
      return null;
    }

    try {
      const text = buildPostText(postData);
      const images = sanitizeImages(postData.images, 4);

      let result;
      switch (this.#provider) {
        case PROVIDERS.OPENAI:
          result = await this.#analyzeWithOpenAI(text, images, SYSTEM_PROMPT_ANALYZE);
          break;
        case PROVIDERS.ANTHROPIC:
          result = await this.#analyzeWithAnthropic(text, images, SYSTEM_PROMPT_ANALYZE);
          break;
        case PROVIDERS.GEMINI:
          result = await this.#analyzeWithGemini(text, images, SYSTEM_PROMPT_ANALYZE);
          break;
        case PROVIDERS.CLOUD:
          result = await this.#analyzeWithCloud('analyze_post', {
            text,
            images,
            systemPrompt: SYSTEM_PROMPT_ANALYZE,
          });
          break;
        default:
          throw new Error(`Provider không được hỗ trợ: ${this.#provider}`);
      }

      return this.#validateAnalyzeResult(result);
    } catch (err) {
      console.error('[AIService] Lỗi phân tích bài đăng:', err);
      return null;
    }
  }

  /**
   * So sánh nhiều sản phẩm và đưa ra khuyến nghị.
   * @param {Product[]} products
   * @returns {Promise<ComparisonResult|null>}
   */
  async compareProducts(products) {
    if (!this.isConfigured()) {
      console.warn('[AIService] Chưa cấu hình API key.');
      return null;
    }

    if (!Array.isArray(products) || products.length < 2) {
      console.warn('[AIService] Cần ít nhất 2 sản phẩm để so sánh.');
      return null;
    }

    try {
      const text = this.#buildCompareText(products);

      let result;
      switch (this.#provider) {
        case PROVIDERS.OPENAI:
          result = await this.#analyzeWithOpenAI(text, [], SYSTEM_PROMPT_COMPARE);
          break;
        case PROVIDERS.ANTHROPIC:
          result = await this.#analyzeWithAnthropic(text, [], SYSTEM_PROMPT_COMPARE);
          break;
        case PROVIDERS.GEMINI:
          result = await this.#analyzeWithGemini(text, [], SYSTEM_PROMPT_COMPARE);
          break;
        case PROVIDERS.CLOUD:
          result = await this.#analyzeWithCloud('compare_products', {
            text,
            systemPrompt: SYSTEM_PROMPT_COMPARE,
          });
          break;
        default:
          throw new Error(`Provider không được hỗ trợ: ${this.#provider}`);
      }

      return this.#validateCompareResult(result, products);
    } catch (err) {
      console.error('[AIService] Lỗi so sánh sản phẩm:', err);
      return null;
    }
  }

  // ─────────────────────────────────────────────
  //  OPENAI
  // ─────────────────────────────────────────────

  async #analyzeWithOpenAI(text, images, systemPrompt) {
    const userContent = this.#buildOpenAIUserContent(text, images);

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        max_tokens: 1024,
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`OpenAI API lỗi ${response.status}: ${errorBody}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('OpenAI không trả về nội dung.');

    return parseJSONResponse(content);
  }

  /**
   * Xây dựng mảng content cho OpenAI vision (text + ảnh).
   */
  #buildOpenAIUserContent(text, images) {
    const content = [{ type: 'text', text }];

    for (const url of images) {
      content.push({
        type: 'image_url',
        image_url: { url, detail: 'low' },
      });
    }

    return content;
  }

  // ─────────────────────────────────────────────
  //  ANTHROPIC
  // ─────────────────────────────────────────────

  async #analyzeWithAnthropic(text, images, systemPrompt) {
    const userContent = await this.#buildAnthropicUserContent(text, images);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.#apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Anthropic API lỗi ${response.status}: ${errorBody}`);
    }

    const data = await response.json();
    const content = data?.content?.[0]?.text;
    if (!content) throw new Error('Anthropic không trả về nội dung.');

    return parseJSONResponse(content);
  }

  /**
   * Xây dựng mảng content cho Anthropic vision.
   * Ảnh phải được tải về và encode base64 vì Anthropic không nhận URL trực tiếp từ Facebook.
   */
  async #buildAnthropicUserContent(text, images) {
    const content = [];

    for (const url of images) {
      try {
        const { base64, mediaType } = await this.#fetchImageAsBase64(url);
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: base64 },
        });
      } catch (err) {
        console.warn('[AIService] Không thể tải ảnh cho Anthropic:', url, err.message);
      }
    }

    content.push({ type: 'text', text });
    return content;
  }

  // ─────────────────────────────────────────────
  //  GEMINI
  // ─────────────────────────────────────────────

  async #analyzeWithGemini(text, images, systemPrompt) {
    const parts = await this.#buildGeminiParts(text, images);

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${this.#apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 1024,
            responseMimeType: 'application/json',
          },
        }),
      }
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Gemini API lỗi ${response.status}: ${errorBody}`);
    }

    const data = await response.json();
    const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) throw new Error('Gemini không trả về nội dung.');

    return parseJSONResponse(content);
  }

  async #buildGeminiParts(text, images) {
    const parts = [{ text }];

    for (const url of images) {
      try {
        const { base64, mediaType } = await this.#fetchImageAsBase64(url);
        parts.push({ inline_data: { mime_type: mediaType, data: base64 } });
      } catch (err) {
        console.warn('[AIService] Không thể tải ảnh cho Gemini:', url, err.message);
      }
    }

    return parts;
  }

  // ─────────────────────────────────────────────
  //  CLOUD ENDPOINT
  // ─────────────────────────────────────────────

  async #analyzeWithCloud(action, payload) {
    if (!this.#cloudEndpoint) {
      throw new Error('Cloud endpoint chưa được cấu hình.');
    }

    const response = await fetch(this.#cloudEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify({ action, ...payload }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Cloud API lỗi ${response.status}: ${errorBody}`);
    }

    const data = await response.json();

    // Cloud endpoint có thể trả về { result: {...} } hoặc trực tiếp object
    return data?.result ?? data;
  }

  // ─────────────────────────────────────────────
  //  HELPERS
  // ─────────────────────────────────────────────

  /**
   * Tải ảnh về và encode base64.
   * @param {string} url
   * @returns {Promise<{ base64: string, mediaType: string }>}
   */
  async #fetchImageAsBase64(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} khi tải ảnh: ${url}`);
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const mediaType = contentType.split(';')[0].trim();

    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const safeMediaType = allowedTypes.includes(mediaType) ? mediaType : 'image/jpeg';

    const buffer = await response.arrayBuffer();
    const base64 = btoa(
      new Uint8Array(buffer).reduce((acc, byte) => acc + String.fromCharCode(byte), '')
    );

    return { base64, mediaType: safeMediaType };
  }

  /**
   * Xây dựng text so sánh sản phẩm.
   * @param {Product[]} products
   * @returns {string}
   */
  #buildCompareText(products) {
    const lines = ['Danh sách sản phẩm cần so sánh:\n'];

    products.forEach((p, index) => {
      lines.push(`--- Sản phẩm ${index + 1} (ID: ${p.id}) ---`);
      if (p.title) lines.push(`Tên: ${p.title}`);
      if (p.price) lines.push(`Giá: ${p.price}`);
      if (p.condition) lines.push(`Tình trạng: ${p.condition}`);
      if (p.description) lines.push(`Mô tả: ${p.description}`);
      if (p.sellerName) lines.push(`Người bán: ${p.sellerName}`);
      if (p.keyFeatures?.length) lines.push(`Đặc điểm: ${p.keyFeatures.join(', ')}`);
      if (p.rawText) lines.push(`Nội dung gốc: ${p.rawText.slice(0, 500)}`);
      lines.push('');
    });

    return lines.join('\n');
  }

  /**
   * Kiểm tra và chuẩn hóa kết quả phân tích.
   */
  #validateAnalyzeResult(raw) {
    if (!raw || typeof raw !== 'object') return null;

    return {
      title: raw.title ?? '',
      price: raw.price ?? '',
      priceNumber: typeof raw.priceNumber === 'number' ? raw.priceNumber : null,
      currency: raw.currency ?? 'VND',
      condition: raw.condition ?? '',
      description: raw.description ?? '',
      category: raw.category ?? '',
      keyFeatures: Array.isArray(raw.keyFeatures) ? raw.keyFeatures : [],
      estimatedValue:
        typeof raw.estimatedValue === 'number' ? raw.estimatedValue : null,
    };
  }

  /**
   * Kiểm tra và chuẩn hóa kết quả so sánh.
   */
  #validateCompareResult(raw, products) {
    if (!raw || typeof raw !== 'object') return null;

    const validIds = new Set(products.map((p) => p.id));

    const rankings = Array.isArray(raw.rankings)
      ? raw.rankings
          .filter((r) => r && typeof r === 'object')
          .map((r) => ({
            id: String(r.id ?? ''),
            pros: Array.isArray(r.pros) ? r.pros : [],
            cons: Array.isArray(r.cons) ? r.cons : [],
            score: typeof r.score === 'number' ? Math.min(100, Math.max(0, r.score)) : 0,
          }))
          .filter((r) => validIds.has(r.id))
      : [];

    return {
      summary: raw.summary ?? '',
      rankings,
      recommendation: raw.recommendation ?? '',
    };
  }
}

// Singleton xuất ra để dùng chung
export const aiService = new AIService();
