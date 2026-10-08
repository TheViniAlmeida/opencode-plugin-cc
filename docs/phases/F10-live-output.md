# F10 — saída ao vivo (saneada)

OpenCode 2.0.22 isolado, escutando num IP privado desta máquina (mascarado como `<private-ip>`), sem inferência. Gerado por `tests/live/f10-remote.mjs`.

### attach http em IP privado e raiz remota (sem inferência)

```json
{
  "refusedWithoutOptIn": {
    "exit": 2,
    "insecureUrl": true,
    "hint": true
  },
  "attachPrivateHttp": {
    "exit": 0,
    "hasProbe": true,
    "tlsWarning": true,
    "remoteWarning": true,
    "stderr": "[opc] aviso: Conexão sem TLS com <private-ip>: a senha e o conteúdo trafegam em claro na rede privada.\n[opc] aviso: As ferramentas rodam em <tmp>/opc-live-f10-6Q6UwK/remote na máquina do servidor. Sincronize via git: push aqui e pull lá antes da tarefa; depois de tarefas com escrita, commit/push lá e pull aqui.\n"
  },
  "remoteRootEnv": {
    "exit": 0,
    "sessionDirectoryIsRemote": true,
    "sessionDirectory": "<tmp>/opc-live-f10-6Q6UwK/remote",
    "stderr": "[opc] aviso: Conexão sem TLS com <private-ip>: a senha e o conteúdo trafegam em claro na rede privada.\n[opc] aviso: As ferramentas rodam em <tmp>/opc-live-f10-6Q6UwK/remote na máquina do servidor. Sincronize via git: push aqui e pull lá antes da tarefa; depois de tarefas com escrita, commit/push lá e pull aqui.\n",
    "listedByOpc": true
  },
  "remoteRootsConfig": {
    "exit": 0,
    "sessionDirectoryIsRemote": true
  },
  "transferRemoteRoot": {
    "exit": 0,
    "leaksPassword": false,
    "usesEnvReference": true,
    "importedDirectoryIsRemote": true,
    "resumeCommand": "cd <tmp>/opc-live-f10-6Q6UwK/local && OPENCODE_SERVER_PASSWORD=\"***\" opencode --server http://<private-ip>:34869 -s ses_ee3cf2f94ffeSlx7rHmZ6ZgPbC",
    "stderr": ""
  }
}
```
