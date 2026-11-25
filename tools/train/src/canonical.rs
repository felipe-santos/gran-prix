//! Canonical JSON (RFC 8785, JCS) and content ids, for the value types that occur in
//! Gran-Prix artifacts: null, bool, string, number, array, object.
//!
//! This mirrors `packages/contracts/src/identity/canonical-json.ts` (the reference
//! implementation, tested with the vectors of RFC 8785 appendices). The tests at the bottom
//! reuse its vectors, and `tests/package_e2e.rs` re-derives the ids of the committed
//! fixtures (`network_def`, `model_id`, `train_config_id`) with this code.
//!
//! * Object members are sorted by the UTF-16 code units of their names.
//! * No insignificant whitespace.
//! * Strings use the `JSON.stringify` escaping (short escapes for `\b \t \n \f \r \" \\`,
//!   `\u00xx` lowercase for the other control characters, everything else raw).
//! * Numbers use the ECMAScript `Number::toString` algorithm over the IEEE-754 double
//!   (`-0` prints as `0`; integers beyond 2^53 lose precision exactly like JS).
//! * Non-finite numbers cannot occur in a `serde_json::Value`.

use crate::error::Result;
use crate::invalid;
use serde_json::Value;
use sha2::{Digest, Sha256};

const MAX_DEPTH: usize = 256;

/// RFC 8785 canonical JSON text of `value`.
pub fn canonical_json(value: &Value) -> Result<String> {
    let mut out = String::new();
    write_value(value, &mut out, 0)?;
    Ok(out)
}

fn write_value(value: &Value, out: &mut String, depth: usize) -> Result<()> {
    if depth > MAX_DEPTH {
        return Err(invalid!("canonical JSON: nesting deeper than {MAX_DEPTH}"));
    }
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(n) => {
            let f = n.as_f64().ok_or_else(|| invalid!("canonical JSON: number {n} is not representable as a double"))?;
            out.push_str(&es_number(f)?);
        }
        Value::String(s) => write_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(item, out, depth + 1)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(key, out);
                out.push(':');
                if let Some(v) = map.get(key.as_str()) {
                    write_value(v, out, depth + 1)?;
                }
            }
            out.push('}');
        }
    }
    Ok(())
}

fn write_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// ECMAScript `Number::toString(f)` for a finite double.
pub fn es_number(f: f64) -> Result<String> {
    if !f.is_finite() {
        return Err(invalid!("canonical JSON: non-finite number"));
    }
    if f == 0.0 {
        return Ok("0".to_string());
    }
    let sign = if f < 0.0 { "-" } else { "" };
    // `{:e}` yields the shortest digits that round-trip, as `d[.ddd]e<exp>`.
    let sci = format!("{:e}", f.abs());
    let (mantissa, exp) = sci.split_once('e').ok_or_else(|| invalid!("unexpected float format {sci}"))?;
    let exp: i32 = exp.parse().map_err(|_| invalid!("unexpected float exponent in {sci}"))?;
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exp + 1; // position of the decimal point relative to the digit string
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let e_sign = if e < 0 { "-" } else { "+" };
        if k == 1 {
            format!("{digits}e{e_sign}{}", e.abs())
        } else {
            format!("{}.{}e{e_sign}{}", &digits[..1], &digits[1..], e.abs())
        }
    };
    Ok(format!("{sign}{body}"))
}

/// Lowercase hex sha256 of raw bytes.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut s = String::with_capacity(64);
    for b in digest {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// `sha256:<hex>` of raw bytes (`sha256Of` in the TS contracts).
pub fn sha256_id(bytes: &[u8]) -> String {
    format!("sha256:{}", sha256_hex(bytes))
}

/// `artifactId(v)` = `sha256:` + sha256 of the canonical JSON text of `v`.
pub fn artifact_id(value: &Value) -> Result<String> {
    Ok(sha256_id(canonical_json(value)?.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn canon(text: &str) -> String {
        let v: Value = serde_json::from_str(text).expect("test input is valid JSON");
        canonical_json(&v).expect("canonicalizes")
    }

    #[test]
    fn sorts_keys_and_keeps_array_order() {
        assert_eq!(canon(r#"{"b":1,"a":2}"#), r#"{"a":2,"b":1}"#);
        assert_eq!(
            canon(r#"{"z":[3,1,2],"y":{"b":{"d":1,"c":2},"a":null}}"#),
            r#"{"y":{"a":null,"b":{"c":2,"d":1}},"z":[3,1,2]}"#
        );
        assert_eq!(canon("{}"), "{}");
        assert_eq!(canon("[]"), "[]");
        assert_eq!(canon(r#"{"a":[],"b":{}}"#), r#"{"a":[],"b":{}}"#);
    }

    /// RFC 8785 section 3.2.3: keys sort by UTF-16 code units, so U+1F600 (surrogate pair
    /// D83D DE00) sorts before U+FB33.
    #[test]
    fn sorts_keys_by_utf16_code_units() {
        let input = json!({
            "\u{20ac}": "Euro Sign",
            "\r": "Carriage Return",
            "\u{fb33}": "Hebrew Letter Dalet With Dagesh",
            "1": "One",
            "\u{1f600}": "Emoji: Grinning Face",
            "\u{80}": "Control",
            "\u{f6}": "Latin Small Letter O With Diaeresis",
        });
        let out = canonical_json(&input).expect("canonicalizes");
        let order = ["\r", "1", "\u{80}", "\u{f6}", "\u{20ac}", "\u{1f600}", "\u{fb33}"];
        let positions: Vec<usize> = order
            .iter()
            .map(|k| {
                let key = canonical_json(&json!(k)).expect("string");
                out.find(&format!("{key}:")).expect("key present")
            })
            .collect();
        let mut sorted = positions.clone();
        sorted.sort_unstable();
        assert_eq!(positions, sorted, "keys out of RFC order in {out}");
    }

    /// The full RFC 8785 section 3.2.2 sample, verbatim from the TS test.
    #[test]
    fn matches_the_rfc_8785_sample() {
        let input = "{\"numbers\":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],\
            \"string\":\"\\u20ac$\\u000F\\u000aA'\\u0042\\u0022\\u005c\\\\\\\"\\/\",\"literals\":[null,true,false]}";
        let expected = "{\"literals\":[null,true,false],\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27],\
            \"string\":\"\u{20ac}$\\u000f\\nA'B\\\"\\\\\\\\\\\"/\"}";
        assert_eq!(canon(input), expected);
    }

    /// The number table of `canonical-json.test.ts` (ECMAScript Number::toString).
    #[test]
    fn formats_numbers_like_ecmascript() {
        let cases: &[(f64, &str)] = &[
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-1.0, "-1"),
            (4.5, "4.5"),
            (0.002, "0.002"),
            (1e21, "1e+21"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (123456789012345680000.0, "123456789012345680000"),
            (1e30, "1e+30"),
            (0.000001, "0.000001"),
            (0.0000001, "1e-7"),
            (333333333.3333333, "333333333.3333333"),
            (9007199254740991.0, "9007199254740991"),
            (-9007199254740991.0, "-9007199254740991"),
            (9223372036854775807.0, "9223372036854776000"),
            (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
            (4294967295.0, "4294967295"),
            (0.1 + 0.2, "0.30000000000000004"),
            (0.3f32 as f64, "0.30000001192092896"),
        ];
        for (n, text) in cases {
            assert_eq!(es_number(*n).expect("finite"), *text, "number {n:e}");
        }
    }

    #[test]
    fn integers_and_floats_that_are_whole_print_alike() {
        assert_eq!(canon("[1, 1.0, 100, 1e2]"), "[1,1,100,100]");
    }

    #[test]
    fn escapes_strings_like_json_stringify() {
        assert_eq!(canonical_json(&json!("a\"b\\c\n\t\u{8}\u{c}\r")).expect("ok"), "\"a\\\"b\\\\c\\n\\t\\b\\f\\r\"");
        assert_eq!(canonical_json(&json!("\u{0}\u{1f}")).expect("ok"), "\"\\u0000\\u001f\"");
        assert_eq!(canonical_json(&json!("/")).expect("ok"), "\"/\"");
        assert_eq!(canonical_json(&json!("caf\u{e9} \u{20ac} \u{1f600}\u{2028}")).expect("ok"), "\"caf\u{e9} \u{20ac} \u{1f600}\u{2028}\"");
    }

    #[test]
    fn float32_values_survive_a_round_trip() {
        let f = 0.1f32;
        let text = canonical_json(&json!(f as f64)).expect("ok");
        assert_eq!(text, "0.10000000149011612");
        let back: f64 = text.parse().expect("parses");
        assert_eq!(back as f32, f);
    }

    /// Digests are computed over numbers parsed back from the written files. Without
    /// serde_json's `float_roundtrip` feature some printed doubles parse one ulp off, which
    /// made `model_id` unverifiable for a real 40-feature model in a release build.
    /// (`cargo test` also enables the feature through the jsonschema dev-dependency, so this
    /// test guards the property, while the explicit feature in Cargo.toml guarantees it.)
    #[test]
    fn printed_float32_values_parse_back_exactly() {
        let mut s = 0x9E37_79B9_7F4A_7C15u64;
        for _ in 0..200_000 {
            s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let f = f32::from_bits((s >> 32) as u32);
            if !f.is_finite() {
                continue;
            }
            let text = serde_json::to_string(&json!(f64::from(f))).expect("prints");
            let back: Value = serde_json::from_str(&text).expect("parses");
            assert_eq!(back.as_f64(), Some(f64::from(f)), "{text}");
            assert_eq!(canonical_json(&back).expect("canon"), canonical_json(&json!(f64::from(f))).expect("canon"));
        }
    }

    #[test]
    fn rejects_runaway_nesting() {
        let mut v = json!(1);
        for _ in 0..300 {
            v = json!([v]);
        }
        assert!(canonical_json(&v).is_err());
    }

    #[test]
    fn sha256_known_answers() {
        assert_eq!(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(artifact_id(&json!({"b": 1, "a": 2})).expect("ok"), sha256_id(br#"{"a":2,"b":1}"#));
    }
}
