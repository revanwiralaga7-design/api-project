/**
 * Auto-generated lewat halaman /admin.html — silakan dirapikan lagi
 * kalau perlu, ini cuma hasil scaffold dari kode yang di-paste.
 */
import * as cheerio from "cheerio";

class Nimegami {
  constructor() {
    this.baseUrl = "https://nimegami.id/";
    this.defaultHeaders = {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    };
  }

  async _fetch(url) {
    const res = await fetch(url, { headers: this.defaultHeaders });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  }

  async home() {
    const html = await this._fetch(this.baseUrl);
    const $ = cheerio.load(html);
    const items = [];
    $("article").each((_, el) => {
      const $el = $(el);
      const title = $el.find("h2, h3").text().trim();
      const link = $el.find("a").first().attr("href");
      const image = $el.find("img").attr("src");
      if (title && link) items.push({ title, link, image: image || "" });
    });
    return items;
  }

  async search(query) {
    if (!query) throw new Error("Query is required");
    const html = await this._fetch(`${this.baseUrl}?s=${encodeURIComponent(query)}`);
    const $ = cheerio.load(html);
    const results = [];
    $("article").each((_, el) => {
      const $el = $(el);
      const title = $el.find("h2, h3").text().trim();
      const link = $el.find("a").first().attr("href");
      const image = $el.find("img").attr("src");
      if (title && link) results.push({ title, link, image: image || "" });
    });
    return results.slice(0, 3); // ubah disini, default output search hanya 3 hasil teratas
  }

  async detail(url) {
    if (!url) throw new Error("URL is required");
    const html = await this._fetch(url);
    const $ = cheerio.load(html);
    const title = $("h1.entry-title, h2.entry-title").text().trim() || $("title").text().trim();
    const synopsis = $(".entry-content p").first().text().trim();
    const video = $("iframe").attr("src") || "";
    const downloads = [];
    $(".download a, .mctnx a, .entry-content a").each((_, el) => {
      const href = $(el).attr("href");
      const text = $(el).text().trim();
      if (href && text && !href.includes("nimegami")) {
        downloads.push({ server: text, url: href });
      }
    });
    return { title, synopsis, video, downloads: downloads.slice(0, 6) }; // ubah disini, default download hanya 6 link terbaik
  }
}

export default Nimegami;
