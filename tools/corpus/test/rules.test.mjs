import { describe, expect, it } from "vitest";
import { adultContent, detectLanguage, evaluatePage, outOfScopeType, personalProfileOrPii, serverVisibleChars, textStats } from "../src/rules.mjs";

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

describe("language", () => {
  it("detects en, pt, es", () => {
    expect(detectLanguage("This is a short English paragraph about how to configure the server and install the package.")).toBe("en");
    expect(detectLanguage("Esta é uma página de documentação sobre como instalar o pacote e configurar o servidor corretamente.")).toBe("pt");
    expect(detectLanguage("Esta es una página sobre cómo instalar el paquete y configurar el servidor correctamente en tu equipo.")).toBe("es");
  });
});

describe("heuristics", () => {
  it("out-of-scope type: search, login, query", () => {
    expect(outOfScopeType("https://x.com/search?q=a")).toBe(true);
    expect(outOfScopeType("https://x.com/login")).toBe(true);
    expect(outOfScopeType("https://x.com/blog/post", "Sign in | Example")).toBe(true);
    expect(outOfScopeType("https://x.com/blog/post", "Login Security Solution - WordPress plugin")).toBe(false);
    expect(outOfScopeType("https://x.com/blog/searching-for-answers")).toBe(false);
  });
  it("adult and personal profile", () => {
    expect(adultContent("https://www.xvideos.com/a", "", "")).toBe(true);
    expect(adultContent("https://x.com/a", "Garden tips", "tomatoes and basil")).toBe(false);
    expect(personalProfileOrPii("https://www.linkedin.com/in/someone", "")).toBe("personal-profile");
    expect(personalProfileOrPii("https://github.com/someone", "")).toBe("personal-profile");
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
    expect(evaluatePage({ ...base, nodes: [node(-1, ""), node(0, fr.repeat(5))] }).reasons).toEqual(["language:fr"]);
  });
  it("SPA rule: server text must be < 200 and rendered text > 1000", () => {
    const spa = { ...base, category: "spa" };
    expect(evaluatePage({ ...spa, serverChars: 150, nodes: page(10) }).reasons).toEqual([]);
    expect(evaluatePage({ ...spa, serverChars: 250, nodes: page(10) }).reasons).toEqual(["spa-rule:server-text>=200"]);
    expect(evaluatePage({ ...spa, serverChars: 10, nodes: page(5) }).reasons).toEqual(["spa-rule:rendered-text<=1000"]);
  });
});
