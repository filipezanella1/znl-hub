use acadrust::{CadDocument, DwgReader, DwgWriter, DxfReader, DxfWriter};
use acadrust::types::DxfVersion;
use std::io::Cursor;
use wasm_bindgen::prelude::*;

fn parse_version(v: &str) -> Result<DxfVersion, String> {
    Ok(match v {
        "AC1015" | "2000" => DxfVersion::AC1015,
        "AC1018" | "2004" => DxfVersion::AC1018,
        "AC1021" | "2007" => DxfVersion::AC1021,
        "AC1024" | "2010" => DxfVersion::AC1024,
        "AC1027" | "2013" => DxfVersion::AC1027,
        "AC1032" | "2018" => DxfVersion::AC1032,
        _ => return Err(format!("Versão não suportada: {v}")),
    })
}

fn is_dwg(bytes: &[u8]) -> bool {
    bytes.len() > 6 && &bytes[0..2] == b"AC"
}

pub fn read_doc(bytes: &[u8]) -> Result<CadDocument, String> {
    if is_dwg(bytes) {
        let mut r = DwgReader::from_stream(Cursor::new(bytes.to_vec()));
        match r.read() {
            Ok(d) => Ok(d),
            Err(e) => {
                // tentativa com recuperação
                let mut r2 = DwgReader::from_stream(Cursor::new(bytes.to_vec()));
                r2.recover().map(|o| o.document).map_err(|e2| format!("Falha ao ler DWG: {e} / {e2}"))
            }
        }
    } else {
        DxfReader::from_reader(Cursor::new(bytes.to_vec()))
            .and_then(|r| r.read())
            .map_err(|e| format!("Falha ao ler DXF: {e}"))
    }
}

thread_local! { static REPORT: std::cell::RefCell<String> = std::cell::RefCell::new(String::new()); }

/// Extrai o handle de mensagens como "... at handle 0xFEF ..." ou "... on entity 0x99F ...".
fn handle_in(msg: &str) -> Option<u64> {
    for key in ["at handle ", "on entity ", "on attribute ", "at handle\t"] {
        if let Some(i) = msg.find(key) {
            let t: String = msg[i + key.len()..].chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
            let t = t.trim_start_matches("0x").trim_start_matches("0X");
            if let Ok(v) = u64::from_str_radix(t, 16) { return Some(v); }
        }
    }
    None
}

fn name_in(msg: &str) -> String {
    // "Cannot encode custom object DATATABLE at handle ..." -> DATATABLE
    for key in ["custom object ", "custom entity ", "Arch entity ", "Arch object "] {
        if let Some(i) = msg.find(key) {
            return msg[i + key.len()..].split_whitespace().next().unwrap_or("?").to_string();
        }
    }
    "objeto".into()
}

pub fn convert_native(bytes: &[u8], target: &str, format: &str) -> Result<Vec<u8>, String> {
    let ver = parse_version(target)?;
    let mut doc = read_doc(bytes)?;
    doc.version = ver;
    REPORT.with(|r| r.borrow_mut().clear());
    if format == "dxf" {
        return DxfWriter::new(&doc).with_version(ver).write_to_vec().map_err(|e| format!("Falha ao gravar DXF: {e}"));
    }
    // Objetos personalizados (Civil 3D, AEC, plugins) que não podem ser regravados em outra versão
    // são retirados um a um; o restante do desenho é convertido normalmente.
    let mut removed: Vec<String> = Vec::new();
    for _ in 0..20000 {
        match DwgWriter::write_to_vec(&doc) {
            Ok(v) => {
                if !removed.is_empty() {
                    let mut counts: std::collections::BTreeMap<String, usize> = Default::default();
                    for n in &removed { *counts.entry(n.clone()).or_default() += 1; }
                    let txt = counts.iter().map(|(k, v)| format!("{k} ×{v}")).collect::<Vec<_>>().join(", ");
                    REPORT.with(|r| *r.borrow_mut() = txt);
                }
                return Ok(v);
            }
            Err(e) => {
                let msg = e.to_string();
                let strip = msg.contains("compatible raw DWG data is required") || msg.contains("unsupported value type");
                match (strip, handle_in(&msg)) {
                    (true, Some(h)) => {
                        let hd = acadrust::types::Handle::from(h);
                        let ok = doc.remove_entity(hd).is_some() || doc.objects.remove(&hd).is_some();
                        if !ok { return Err(format!("Falha ao gravar DWG: {msg}")); }
                        removed.push(name_in(&msg));
                        if removed.len() % 50 == 1 { let _ = doc.repair(); }
                    }
                    _ => return Err(format!("Falha ao gravar DWG: {msg}")),
                }
            }
        }
    }
    Err("Falha ao gravar DWG: objetos incompatíveis demais".into())
}

#[wasm_bindgen]
pub fn last_report() -> String { REPORT.with(|r| r.borrow().clone()) }

#[wasm_bindgen]
pub fn convert(bytes: &[u8], target: &str, format: &str) -> Result<Vec<u8>, JsError> {
    convert_native(bytes, target, format).map_err(|e| JsError::new(&e))
}

#[wasm_bindgen]
pub fn file_version(bytes: &[u8]) -> String {
    if is_dwg(bytes) { String::from_utf8_lossy(&bytes[0..6]).to_string() } else { "DXF".into() }
}
