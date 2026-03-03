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

  // --- enviar ficheiro ---
  ctx.subscriptions.push(vscode.commands.registerCommand('sshSync.uploadFile', async (item?: FileItem) => {
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
      // usa ficheiro activo no editor
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showWarningMessage('nenhum ficheiro aberto'); return; }
      localPath  = editor.document.uri.fsPath;
      remotePath = localToRemote(localPath, activeConn);
    }

    if (!remotePath) { vscode.window.showErrorMessage('não foi possível determinar caminho remoto'); return; }

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

export function deactivate() {
  activeClient?.disconnect();
}
