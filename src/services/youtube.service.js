import axios from "axios";
import { CookieJar } from "tough-cookie";
import { wrapper } from "axios-cookiejar-support";
import { ApiError } from "../utils/response.js";

class YouTubeSearch {
  constructor() {
    this.client = wrapper(axios.create({ jar: new CookieJar() }));
  }

  async search(query) {
    const { data: html } = await this.client.get("https://www.youtube.com/results", {
      headers: {
        accept: "*/*",
        "accept-language": "en-US,en;q=0.9",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
      },
      params: { search_query: query }
    });

    const match =
      html?.match(/var ytInitialData = (\{[\s\S]*?\});/) ||
      html?.match(/var ytInitialData\s*=\s*(\{[\s\S]*?\});\s*var/);
    if (!match) throw new ApiError("Gagal parse YouTube data", 502);
    return this._parseResults(JSON.parse(match[1]));
  }

  _parseResults(json) {
    const contents =
      json.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]
        ?.itemSectionRenderer?.contents;
    if (!contents) return [];
    return contents
      .filter((c) => c.videoRenderer)
      .map((c) => {
        const d = c.videoRenderer;
        return {
          id: d.videoId,
          url: `https://www.youtube.com/watch?v=${d.videoId}`,
          title: d.title?.runs?.[0]?.text || "",
          author: d.ownerText?.runs?.[0]?.text || "",
          views: d.viewCountText?.simpleText || "",
          duration: d.lengthText?.accessibility?.accessibilityData?.label || "",
          thumbnail: d.thumbnail?.thumbnails?.pop()?.url || "",
          published: d.publishedTimeText?.simpleText || ""
        };
      });
  }
}

export async function ytmp3Search(query) {
  const searcher = new YouTubeSearch();
  return searcher.search(query);
}

export default ytmp3Search;
