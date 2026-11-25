import sys, json
sys.path.insert(0, sys.argv[1])
import tiktoken
e = tiktoken.get_encoding("cl100k_base")
cases = [
  "tiktoken is great!", "hello world", "Hello, world!", "", " ", "\n\n", "a",
  "The quick brown fox jumps over the lazy dog.",
  "# Title\n\nSome **bold** text and a [link](https://example.com/a?b=c).\n\n* item 1\n* item 2\n",
  "<div class=\"a\" id=\"b\"><p>Hello &amp; goodbye</p></div>",
  "naïve café 日本語のテキスト \U0001f600 emoji",
  "def f(x):\n    return x ** 2  # square\n",
  "a" * 50, "word " * 40, "<|endoftext|>", "1234567890 3.14159 1,000,000",
]
out = [{"text": c, "tokens": e.encode(c, disallowed_special=()), "n": len(e.encode(c, disallowed_special=()))} for c in cases]
print(json.dumps({"tiktoken": tiktoken.__version__, "encoding": "cl100k_base", "cases": out}, ensure_ascii=True))
