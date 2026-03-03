# SSH Folder Sync — Plugin VS Code

Réplica local de pastas SSH com sincronização automática.

## Funcionalidades

| Funcionalidade | Descrição |
|---|---|
| 🔌 Ligação SSH | utilizador + password, guardada no keychain do sistema |
| 📁 Explorador lateral | navega ficheiros remotos directamente no VS Code |
| ⬆ Upload automático | envia ao guardar (`Ctrl+S`) |
| ⬇ Download manual | descarrega qualquer ficheiro remoto |
| ↔ Diff | compara versão local com remota |
| 💾 Réplica persistente | pasta local mantida entre sessões |

---

## Instalação

### Pré-requisitos
- Node.js 18+
- VS Code 1.85+

### Passos

```bash
git clone <repo>
cd ssh-folder-sync
npm install
npm run compile
```

Para testar localmente no VS Code:
1. Abre a pasta no VS Code
2. Prime `F5` para lançar a janela de extensão

Para instalar como `.vsix`:
```bash
npm install -g @vscode/vsce
vsce package
code --install-extension ssh-folder-sync-0.1.0.vsix
```

---

## Configuração

### Definição obrigatória

Antes de criar a primeira ligação, define a pasta base local em `settings.json`:

```json
{
  "sshSync.localBasePath": "/var/www/mysite"
}
```

Cada ligação cria uma sub-pasta automaticamente dentro desta.

### Definições disponíveis

| Definição | Tipo | Padrão | Descrição |
|---|---|---|---|
| `sshSync.localBasePath` | string | `""` | pasta base para réplicas |
| `sshSync.autoSyncOnSave` | boolean | `true` | enviar automaticamente ao guardar |
| `sshSync.connections` | array | `[]` | ligações guardadas (gerido automaticamente) |

---

## Utilização

### 1. Criar ligação

- Clica no ícone **SSH Sync** na barra lateral esquerda
- Clica no **+** no painel "Ligações"
- Preenche: nome, host, porta, utilizador, password, pasta remota

A password é guardada de forma segura no keychain do sistema operativo.

### 2. Ligar

- Clica numa ligação no painel lateral
- Na primeira ligação, oferece descarregar toda a pasta remota

### 3. Trabalhar com ficheiros

| Acção | Como |
|---|---|
| Ver ficheiros remotos | painel "Ficheiros Remotos" |
| Abrir ficheiro local | clica no ficheiro (com ✓ local) |
| Descarregar remoto | clica direito → "descarregar ficheiro" |
| Enviar manualmente | clica direito → "enviar ficheiro" |
| Comparar versões | clica direito → "comparar com remoto" |
| Auto-envio ao guardar | activo por omissão (`Ctrl+S`) |

### 4. Auto-sync

Ao guardar qualquer ficheiro dentro da pasta de réplica activa, o plugin envia automaticamente para o servidor. O estado aparece na barra de estado inferior.

---

## Estrutura do projecto

```
ssh-folder-sync/
├── src/
│   ├── extension.ts         # ponto de entrada, registo de comandos
│   ├── sshClient.ts         # ligação ssh/sftp (ssh2)
│   ├── connectionManager.ts # gestão de ligações e passwords
│   ├── treeProvider.ts      # explorador lateral (ligações + ficheiros)
│   ├── diffHelper.ts        # diff local vs remoto
│   └── types.ts             # tipos partilhados
├── package.json
└── tsconfig.json
```

---

## Notas

- As passwords são armazenadas no **Secret Storage** do VS Code (keychain do SO), não em texto simples
- A pasta local é **persistente** — os ficheiros ficam mesmo após fechar o VS Code
- O diff usa o diff nativo do VS Code (não precisa extensões extra)
- Ligações SSH com chave RSA não estão incluídas nesta versão (mas a `ssh2` suporta — ver `privateKey` nas opções)
