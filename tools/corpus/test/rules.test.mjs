import { describe, expect, it } from "vitest";
import { adultContent, decideLanguage, evaluatePage, htmlLangPrimary, languageSample, outOfScopeType, personalProfileOrPii, serverVisibleChars, textStats } from "../src/rules.mjs";

const node = (parent, text, style = {}) => ({
  parent,
  own_text: text,
  own_text_len: text.length,
  style: { display: "block", visibility: "visible", ...style },
});
const EN = "This is a reasonably long English paragraph about configuring the server, installing the package and running the tests on your machine. ";
const page = (n) => [node(-1, ""), node(0, EN.repeat(n))];

describe("textStats", () => {
  it("counts visible chars, skips display:none subtrees, counts hidden text elements too", () => {
    const nodes = [node(-1, ""), node(0, "hello"), node(0, "", { display: "none" }), node(2, "secret"), node(0, "world", { visibility: "hidden" })];
    expect(textStats(nodes)).toMatchObject({ visibleChars: 5, textElements: 3, visibleText: "hello" });
  });
});

describe("serverVisibleChars", () => {
  it("ignores scripts, styles, noscript, head, comments and tags", () => {
    const html = "<html><head><title>T</title><style>a{}</style></head><body><!-- c --><div id=root></div><script>var x=1234567890</script><noscript>Enable JS please</noscript><p>Hi&nbsp;there</p></body></html>";
    expect(serverVisibleChars(html)).toBe("Hi there".length);
  });
  it("an empty SPA shell is far under 200", () => {
    expect(serverVisibleChars('<html><body><div id="app"></div><script src="/bundle.js"></script></body></html>')).toBe(0);
  });
});

describe("language (attempt 2 rule)", () => {
  const EN_S = "This is a short English paragraph about how to configure the server and install the package.";
  const PT_S = "Esta é uma página de documentação sobre como instalar o pacote e configurar o servidor corretamente.";
  const ES_S = "Esta es una página sobre cómo instalar el paquete y configurar el servidor correctamente en tu equipo.";
  it("detects en, pt, es with no html lang", () => {
    expect(decideLanguage(EN_S, null).lang).toBe("en");
    expect(decideLanguage(PT_S, null).lang).toBe("pt");
    expect(decideLanguage(ES_S, null).lang).toBe("es");
  });
  it("html lang wins when it is among the detector's top 3, otherwise the detector wins", () => {
    expect(decideLanguage(EN_S, "en-US")).toMatchObject({ lang: "en", source: "html-lang(in-top3)" });
    expect(decideLanguage(PT_S, "en")).toMatchObject({ lang: "pt", source: "detector" }); // declared en, text is clearly pt
  });
  it("falls back to html lang when the detector does not decide; empty when nothing decides", () => {
    expect(decideLanguage("", "de")).toMatchObject({ lang: "de", source: "html-lang(detector-undecided)" });
    expect(decideLanguage("", null).lang).toBe("");
  });
  it("htmlLangPrimary accepts well-formed tags only", () => {
    expect(htmlLangPrimary("en-US")).toBe("en");
    expect(htmlLangPrimary("PT_br")).toBe("pt");
    expect(htmlLangPrimary("x-default")).toBeNull();
    expect(htmlLangPrimary("")).toBeNull();
    expect(htmlLangPrimary(null)).toBeNull();
  });
  it("the sample is the visible units of >= 40 chars up to 5000, or all the text when fewer than 300 remain", () => {
    const long = "a".repeat(2600);
    expect(languageSample([long, long, long], "x").length).toBe(5000);
    expect(languageSample(["short sentence of forty characters or more."], "all the text of the page")).toBe("all the text of the page");
    const nodes = [node(-1, ""), node(0, "Menu"), node(0, EN_S.repeat(5))];
    expect(textStats(nodes).sentences).toEqual([EN_S.repeat(5)]);
  });
  it("short technical English with html lang=en stays en even if the detector's first guess is another language", () => {
    const api = Array.from({ length: 12 }, (_, i) => `GET /v1/charges/{id}${i} returns the charge object; use expand[] to include related objects.`).join(" ");
    expect(evaluatePage({ category: "docs", requestedUrl: "https://docs.example.org/api", httpStatus: 200, flags: [], title: "API", htmlLang: "en-US", nodes: [node(-1, ""), node(0, api)] }).lang).toBe("en");
  });
});

describe("heuristics", () => {
  it("out-of-scope type: search, login, query; but not documentation about them", () => {
    expect(outOfScopeType("https://x.com/search?q=a")).toBe(true);
    expect(outOfScopeType("https://x.com/login")).toBe(true);
    expect(outOfScopeType("https://x.com/en-us/login/")).toBe(true);
    expect(outOfScopeType("https://supabase.com/docs/guides/auth")).toBe(false);
    expect(outOfScopeType("https://docs.example.org/api/search")).toBe(false);
    expect(outOfScopeType("https://x.com/feed/how-to-read-rss")).toBe(false);
    expect(outOfScopeType("https://x.com/tweet?s=20")).toBe(false);
    expect(outOfScopeType("https://x.com/blog?s=weather")).toBe(true);
    expect(outOfScopeType("https://x.com/blog/post", "Sign in | Example")).toBe(true);
    expect(outOfScopeType("https://x.com/blog/post", "Login Security Solution - WordPress plugin")).toBe(false);
    expect(outOfScopeType("https://x.com/blog/searching-for-answers")).toBe(false);
  });
  it("adult and personal profile", () => {
    expect(adultContent("https://www.xvideos.com/a", "", "")).toBe(true);
    expect(adultContent("https://x.com/a", "Garden tips", "tomatoes and basil")).toBe(false);
    // keyword traps: "Java 18+", placeholder xxx, a single mention
    expect(adultContent("https://docs.spring.io/boot", "Spring Boot", "Requires Java 18+. Needs JDK 18+ and Maven 3.9+. Node 18+ also works. Bearer xxx, token xxx, id xxx-xxx.")).toBe(false);
    expect(adultContent("https://x.com/a", "Age gate", "This site is for adults only. You must be 18 to enter. 18+ only content follows.")).toBe(true);
    expect(adultContent("https://x.com/a", "Videos", "Watch xxx videos. More xxx movies. Best xxx porn.")).toBe(true);
    expect(personalProfileOrPii("https://www.linkedin.com/in/someone", "")).toBe("personal-profile");
    expect(personalProfileOrPii("https://github.com/someone", "")).toBe("personal-profile");
    expect(personalProfileOrPii("https://github.com/features", "")).toBeNull();
    expect(personalProfileOrPii("https://github.com/enterprise", "")).toBeNull();
    expect(personalProfileOrPii("https://forum.example.org/members/jane.1234/", "")).toBe("personal-profile");
    expect(personalProfileOrPii("https://example.org/people/", "")).toBeNull();
    expect(personalProfileOrPii("https://example.org/docs", "a@example.com b@example.org c@test.invalid d@example.net e@domain.com f@yourdomain.com")).toBeNull();
    expect(personalProfileOrPii("https://github.com/org/repo", "")).toBeNull();
    expect(personalProfileOrPii("https://example.com/contact", "a@x.org b@x.org c@x.org d@x.org e@x.org")).toBe("pii-evident");
  });
});

describe("evaluatePage (§2.2, §2.1)", () => {
  const base = { category: "article", requestedUrl: "https://example.com/post", httpStatus: 200, flags: [], title: "A post" };
  it("accepts an ordinary English page", () => {
    expect(evaluatePage({ ...base, nodes: page(5) }).reasons).toEqual([]);
  });
  it("rejects thin pages, errors, captcha, paywall, and gigantic pages, with every reason listed", () => {
    expect(evaluatePage({ ...base, nodes: page(1).slice(0, 1).concat(node(0, "short")) }).reasons).toContain("visible-chars<300");
    expect(evaluatePage({ ...base, httpStatus: 404, flags: ["http-error"], nodes: page(5) }).reasons).toEqual(["http-status-404"]);
    expect(evaluatePage({ ...base, flags: ["captcha", "paywall"], nodes: page(5) }).reasons).toEqual(["flag:captcha", "flag:paywall"]);
    const many = [node(-1, "")].concat(Array.from({ length: 5001 }, () => node(0, "word word word")));
    expect(evaluatePage({ ...base, nodes: many }).reasons).toContain("text-elements>5000");
  });
  it("rejects other languages", () => {
    const fr = "Ceci est un long paragraphe en français sur la configuration du serveur et l'installation du paquet sur votre machine. ";
    expect(evaluatePage({ ...base, htmlLang: "en", nodes: [node(-1, ""), node(0, fr.repeat(5))] }).reasons).toEqual(["language:fr"]);
  });
  it("SPA rule: server text must be < 200 and rendered text > 1000", () => {
    const spa = { ...base, category: "spa" };
    expect(evaluatePage({ ...spa, serverChars: 150, nodes: page(10) }).reasons).toEqual([]);
    expect(evaluatePage({ ...spa, serverChars: 250, nodes: page(10) }).reasons).toEqual(["spa-rule:server-text>=200"]);
    expect(evaluatePage({ ...spa, serverChars: 10, nodes: page(5) }).reasons).toEqual(["spa-rule:rendered-text<=1000"]);
  });
});
