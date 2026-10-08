# F7 — saída ao vivo

Executado em DD/MM/AAAA (America/Belem) pelo controlador, com o OpenCode 2.0.22 (`OPC_OPENCODE_BIN`).
`f7-contract.mjs` roda num servidor isolado (HOME/XDG temporários, provider fechado em `127.0.0.1:9`), sem
inferência. `f7-inference.mjs` usa um servidor gerenciado pelo opc com snapshots ligados e os modelos
`omniroute-personal/cmd/deepseek/deepseek-v4-flash` e `omniroute-personal/cmd/Qwen/Qwen3.7-Flash`.
