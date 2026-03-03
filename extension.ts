import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SshClient } from './sshClient';
import { ConnectionManager } from './connectionManager';
import { ConnectionsProvider, ConnItem, RemoteFilesProvider, FileItem } from './treeProvider';
import { showDiff } from './diffHelper';
import { SshConnection } from './types';

let activeClient: SshClient | null = null;
let activeConn:   SshConnection | null = null;

export function activate(ctx: vscode.ExtensionContext) {
  const connMgr   = new ConnectionManager(ctx);
  const connProv  = new ConnectionsProvider(connMgr.getAll(), null);
  const filesProv = new RemoteFilesProvider();

  // regista vistas do painel lateral
  vscode.window.createTreeView('sshSyncConnections', { treeDataProvider: connProv });
  vscode.window.createTreeView('sshSyncFiles',       { treeDataProvider: filesProv, showCollapseAll: true });

  // --- helper: actualiza estado geral ---
  function setConnected(client: SshClient | null, conn: SshConnection | null) {
    activeClient = client;
    activeConn   = conn;
    filesProv.setClient(client, conn);
    connProv.refresh(connMgr.getAll(), conn?.id ?? null);
    vscode.commands.executeCommand('setContext', 'sshSync.connected', !!client);
    const bar = conn ? `$(remote) SSH: ${conn.label}` : `$(remote) SSH: desligado`;
    statusBar.text = bar;
    statusBar.show();
  }

  // barra de estado
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'sshSync.connect';
  statusBar.text    = '$(remote) SSH: desligado';
  statusBar.show();
  ctx.subscriptions.push(statusBar);

  // --- ligar ---
  ctx.subscriptions.push(vscode.commands.registerCommand('sshSync.connect', async (item?: ConnItem | SshConnection) => {
    // desliga ligação anterior se existir
    if (activeClient) { activeClient.disconnect(); setConnected(null, null); }

    let conn: SshConnection | undefined;

    if (item instanceof ConnItem) {
      conn = item.conn;
    } else if (item && 'host' in item) {
      conn = item as SshConnection;
    } else {
      // mostra lista de ligações disponíveis
      const list = connMgr.getAll();
      if (!list.length) {
        const criar = await vscode.window.showInformationMessage('sem ligações configuradas', 'criar nova');
        if (criar) await vscode.commands.executeCommand('sshSync.addConnection');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        list.map(c => ({ label: c.label, description: `${c.username}@${c.host}`, conn: c })),
        { placeHolder: 'escolhe uma ligação' },
      );
      conn = pick?.conn;
    }
    if (!conn) return;

    const pw = await connMgr.resolvePassword(conn);
    if (!pw) return;

    const client = new SshClient();
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `a ligar a ${conn.host}…` },
        async () => { await client.connect(conn!, pw); },
      );
    } catch (err: any) {
      vscode.window.showErrorMessage(`erro ao ligar: ${err.message}`);
      return;
    }

    // verifica se pasta remota existe antes de prosseguir
    const remoteOk = await client.exists(conn.remotePath);
    if (!remoteOk) {
      client.disconnect();
      vscode.window.showErrorMessage(
        `pasta remota não encontrada: "${conn.remotePath}" — verifica o caminho configurado.`
      );
      return;
    }

    setConnected(client, conn);
    vscode.window.showInformationMessage(`ligado a ${conn.label}`);

    // descarrega pasta remota se local vazia
    const localEmpty = !fs.existsSync(conn.localPath) ||
      (await fs.promises.readdir(conn.localPath)).length === 0;

    if (localEmpty) {
      const resp = await vscode.window.showInformationMessage(
        `pasta local vazia. descarregar ${conn.remotePath}?`, 'sim', 'não',
      );
      if (resp === 'sim') {
        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'a descarregar ficheiros…', cancellable: false },
            async (progress) => {
              await fs.promises.mkdir(conn!.localPath, { recursive: true });
              await client.downloadDir(conn!.remotePath, conn!.localPath, progress);
            },
          );
          filesProv.refresh();
          vscode.window.showInformationMessage('download completo');
        } catch (err: any) {
          vscode.window.showErrorMessage(`erro no download: ${err.message}`);
        }
      }
    }
  }));

  // --- desligar ---
  ctx.subscriptions.push(vscode.commands.registerCommand('sshSync.disconnect', () => {
    activeClient?.disconnect();
    setConnected(null, null);
    vscode.window.showInformationMessage('desligado');
  }));

  // --- nova ligação ---
  ctx.subscriptions.push(vscode.commands.registerCommand('sshSync.addConnection', async () => {
    const conn = await connMgr.promptNewConnection();
    if (conn) {
      connProv.refresh(connMgr.getAll(), activeConn?.id ?? null);
      vscode.window.showInformationMessage(`ligação "${conn.label}" guardada`);
    }
  }));

  // --- actualizar explorador ---
  ctx.subscriptions.push(vscode.commands.registerCommand('sshSync.refresh', () => {
    filesProv.refresh();
  }));

  // --- enviar ficheiro usa o caminho local---
ctx.subscriptions.push(vscode.commands.registerCommand('sshSync.uploadFile', async (item?: FileItem | vscode.Uri) => {
    if (!activeClient || !activeConn) {
      vscode.window.showWarningMessage('sem ligação ssh activa');
      return;
    }

    let localPath: string;
    let remotePath: string;

    if (item instanceof vscode.Uri) {
      // veio do explorador nativo — uri do ficheiro
      localPath = item.fsPath;
      remotePath = localToRemote(localPath, activeConn);
    } else if (item instanceof FileItem) {
      localPath  = item.localPath;
      remotePath = item.remotePath;
    } else {
      // veio do atalho de teclado ou barra de título
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showWarningMessage('nenhum ficheiro aberto'); return; }
      localPath  = editor.document.uri.fsPath;
      remotePath = localToRemote(localPath, activeConn);
    }

    if (!remotePath || remotePath.includes('undefined')) {
      vscode.window.showErrorMessage(`ficheiro fora da pasta da ligação activa: ${activeConn.localPath}`);
      return;
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `a enviar ${path.basename(localPath)}…` },
      async () => { await activeClient!.uploadFile(localPath, remotePath); },
    );
    vscode.window.showInformationMessage(`${path.basename(localPath)} enviado`);
    filesProv.refresh();
  }));

  // --- descarregar ficheiro ---
  ctx.subscriptions.push(vscode.commands.registerCommand('sshSync.downloadFile', async (item?: FileItem) => {
    if (!activeClient || !activeConn) {
      vscode.window.showWarningMessage('sem ligação ssh activa');
      return;
    }
    if (!(item instanceof FileItem)) { vscode.window.showWarningMessage('selecciona um ficheiro no explorador'); return; }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `a descarregar ${item.label}…` },
      async () => { await activeClient!.downloadFile(item.remotePath, item.localPath); },
    );
    vscode.window.showInformationMessage(`${item.label} descarregado`);
    filesProv.refresh();

    // abre o ficheiro
    await vscode.window.showTextDocument(vscode.Uri.file(item.localPath));
  }));

  // --- diff ---
  ctx.subscriptions.push(vscode.commands.registerCommand('sshSync.diffFile', async (item?: FileItem) => {
    if (!activeClient || !activeConn) {
      vscode.window.showWarningMessage('sem ligação ssh activa');
      return;
    }

    let localPath: string;
    let remotePath: string;

    if (item instanceof FileItem) {
      localPath  = item.localPath;
      remotePath = item.remotePath;
    } else {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showWarningMessage('nenhum ficheiro aberto'); return; }
      localPath  = editor.document.uri.fsPath;
      remotePath = localToRemote(localPath, activeConn);
    }

    await showDiff(activeClient, localPath, remotePath);
  }));

  // --- auto-sync ao guardar ---
  ctx.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (!activeClient || !activeConn) return;
      const cfg = vscode.workspace.getConfiguration('sshSync');
      if (!cfg.get<boolean>('autoSyncOnSave', true)) return;

      const localPath = doc.uri.fsPath;
      // só sincroniza se o ficheiro estiver dentro da pasta local da ligação activa
      if (!localPath.startsWith(activeConn.localPath)) return;

      const remotePath = localToRemote(localPath, activeConn);
      try {
        await activeClient.uploadFile(localPath, remotePath);
        // mostra mensagem discreta na barra de estado
        statusBar.text = `$(check) SSH: enviado ${path.basename(localPath)}`;
        setTimeout(() => { statusBar.text = `$(remote) SSH: ${activeConn!.label}`; }, 3000);
      } catch (err: any) {
        vscode.window.showErrorMessage(`erro ao enviar: ${err.message}`);
      }
    }),
  );


  // --- editar ligação ---
  ctx.subscriptions.push(vscode.commands.registerCommand('sshSync.editConnection', async (item?: ConnItem) => {
    const conn = item?.conn ?? await pickConnection(connMgr);
    if (!conn) return;

    const label = await vscode.window.showInputBox({ prompt: 'nome da ligação', value: conn.label });
    if (!label) return;
    const host = await vscode.window.showInputBox({ prompt: 'host ou ip', value: conn.host });
    if (!host) return;
    const portStr = await vscode.window.showInputBox({ prompt: 'porta ssh', value: String(conn.port) });
    const port = parseInt(portStr || '22', 10);
    const username = await vscode.window.showInputBox({ prompt: 'utilizador', value: conn.username });
    if (!username) return;
    const changePw = await vscode.window.showQuickPick(['manter password actual', 'alterar password'], { placeHolder: 'password' });
    if (!changePw) return;
    if (changePw === 'alterar password') {
      const pw = await vscode.window.showInputBox({ prompt: 'nova password', password: true });
      if (pw) await connMgr.savePassword(conn.id, pw);
    }
    const remotePath = await vscode.window.showInputBox({ prompt: 'pasta remota', value: conn.remotePath });
    if (!remotePath) return;

    const updated = { ...conn, label, host, port, username, remotePath };
    await connMgr.save(updated);
    connProv.refresh(connMgr.getAll(), activeConn?.id ?? null);
    vscode.window.showInformationMessage(`ligação "${label}" actualizada`);
  }));

  // --- remover ligação ---
  ctx.subscriptions.push(vscode.commands.registerCommand('sshSync.removeConnection', async (item?: ConnItem) => {
    const conn = item?.conn ?? await pickConnection(connMgr);
    if (!conn) return;

    const confirm = await vscode.window.showWarningMessage(
      `remover ligação "${conn.label}"?`, { modal: true }, 'remover',
    );
    if (confirm !== 'remover') return;

    // desliga se for a activa
    if (activeConn?.id === conn.id) {
      activeClient?.disconnect();
      setConnected(null, null);
    }

    await connMgr.remove(conn.id);
    connProv.refresh(connMgr.getAll(), activeConn?.id ?? null);
    vscode.window.showInformationMessage(`ligação "${conn.label}" removida`);
  }));

  // desliga ao fechar janela
  ctx.subscriptions.push(
    new vscode.Disposable(() => { activeClient?.disconnect(); }),
  );
}

// converte caminho local em caminho remoto
function localToRemote(localPath: string, conn: SshConnection): string {
  const rel = path.relative(conn.localPath, localPath);
  return `${conn.remotePath}/${rel}`.replace(/\\/g, '/');
}


// helper: mostra lista de ligações para escolher
async function pickConnection(connMgr: import('./connectionManager').ConnectionManager) {
  const list = connMgr.getAll();
  if (!list.length) { vscode.window.showWarningMessage('sem ligações configuradas'); return undefined; }
  const pick = await vscode.window.showQuickPick(
    list.map(c => ({ label: c.label, description: `${c.username}@${c.host}`, conn: c })),
    { placeHolder: 'escolhe uma ligação' },
  );
  return pick?.conn;
}

export function deactivate() {
  activeClient?.disconnect();
}
