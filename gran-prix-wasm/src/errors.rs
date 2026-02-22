use wasm_bindgen::prelude::*;
use gran_prix::GPError;

pub trait IntoJsResult<T> {
    fn into_js(self) -> Result<T, JsValue>;
}

impl<T> IntoJsResult<T> for Result<T, GPError> {
    fn into_js(self) -> Result<T, JsValue> {
        self.map_err(|e| JsValue::from_str(&e.to_string()))
    }
}

pub fn to_js_error(e: GPError) -> JsValue {
    JsValue::from_str(&e.to_string())
}
