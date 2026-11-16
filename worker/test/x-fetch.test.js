import { describe, it, expect } from "vitest";
import { extractStatusId, normalizeStatusUrl, tweetsLookupUrl, postTextFromTweet, fetchXPosts, fetchXPost, X_TWEETS_BASE } from "../src/signals/x-fetch.js";

describe("X URL normalization", () => {
  it("accepts x.com, twitter.com, www and mobile hosts", () => {
    const id = "1890123456789012345";
    const urls = [
      `https://x.com/Onchain_Matrix/status/${id}`,
      `https://twitter.com/Onchain_Matrix/status/${id}`,
      `https://www.x.com/Onchain_Matrix/status/${id}`,
      `https://www.twitter.com/Onchain_Matrix/status/${id}`,
      `https://mobile.x.com/Onchain_Matrix/status/${id}`,
      `https://mobile.twitter.com/Onchain_Matrix/status/${id}`,
      `http://x.com/Onchain_Matrix/status/${id}`,
      `https://x.com/Onchain_Matrix/statuses/${id}`,
    ];
    for (const u of urls) {
      expect(extractStatusId(u)).toBe(id);
      expect(normalizeStatusUrl(u)).toBe(`https://x.com/Onchain_Matrix/status/${id}`);
    }
  });

  it("rejects non-X URLs and missing status ids", () => {
    expect(extractStatusId("https://example.com/status/1")).toBeNull();
    expect(extractStatusId("https://x.com/Onchain_Matrix")).toBeNull();
    expect(normalizeStatusUrl("not a url")).toBeNull();
  });
});

describe("fetchXPosts", () => {
  it("skips cleanly when the bearer secret is missing", async () => {
    let called = 0;
    const r = await fetchXPosts(["https://x.com/a/status/12345678901"], {
      bearerToken: "",
      fetchImpl: async () => { called++; return new Response("{}"); },
    });
    expect(r).toMatchObject({ ok: false, status: "no_x_secret", posts: {} });
    expect(called).toBe(0);
  });

  it("fetches one or many ids and reads note_tweet text when present", async () => {
    const seen = [];
    const r = await fetchXPosts(
      ["https://twitter.com/foo/status/11111111111", "https://x.com/bar/status/22222222222"],
      {
        bearerToken: "secret-token",
        fetchImpl: async (url, init) => {
          seen.push({ url, auth: init.headers.Authorization });
          return Response.json({
            data: [
              { id: "11111111111", text: "short", author_id: "1" },
              { id: "22222222222", text: "truncated", note_tweet: { text: "full long post" }, author_id: "2" },
            ],
          });
        },
      }
    );
    expect(r.ok).toBe(true);
    expect(seen[0].auth).toBe("Bearer secret-token");
    expect(seen[0].url).toContain(X_TWEETS_BASE);
    expect(seen[0].url).toContain("11111111111");
    expect(seen[0].url).toContain("22222222222");
    expect(r.posts["11111111111"].text).toBe("short");
    expect(r.posts["22222222222"].text).toBe("full long post");
  });

  it("records fetch_failed on HTTP errors and does not throw", async () => {
    const r = await fetchXPost("https://x.com/a/status/12345678901", {
      bearerToken: "x",
      fetchImpl: async () => new Response("nope", { status: 401 }),
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("fetch_failed");
  });
});

describe("postTextFromTweet", () => {
  it("prefers the note_tweet body", () => {
    expect(postTextFromTweet({ text: "a", note_tweet: { text: "b" } })).toBe("b");
    expect(postTextFromTweet({ text: "a" })).toBe("a");
    expect(postTextFromTweet(null)).toBe("");
  });
});

describe("tweetsLookupUrl", () => {
  it("uses a path for one id and a query for many", () => {
    expect(tweetsLookupUrl(["9"])).toBe(`${X_TWEETS_BASE}/9?tweet.fields=${encodeURIComponent("text,created_at,author_id,conversation_id,note_tweet")}`);
    expect(tweetsLookupUrl(["1", "2"])).toContain("?ids=1,2");
    expect(tweetsLookupUrl([])).toBeNull();
  });
});
