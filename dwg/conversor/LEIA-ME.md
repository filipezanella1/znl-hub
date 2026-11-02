# Conversor DWG (WebAssembly)

Gera `dwg/lib/dwgconv.js` e `dwg/lib/dwgconv_bg.wasm`, usados pelo DWG Viewer para gravar DWG/DXF em outra versão.
Baseado no [acadrust](https://github.com/hakanaktt/acadrust) 0.6.8 (MPL-2.0).

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130   # mesma versão do Cargo.lock
cargo build --release --target wasm32-unknown-unknown --lib
wasm-bindgen --target web --no-typescript --out-dir ../lib --out-name dwgconv target/wasm32-unknown-unknown/release/dwgconv.wasm
```

Objetos personalizados sem dados compatíveis com a versão de destino (Civil 3D, AEC, plugins) são retirados
e listados em `last_report()`; o resto do desenho é gravado normalmente.
