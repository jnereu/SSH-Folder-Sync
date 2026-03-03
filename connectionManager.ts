import * as vscode from 'vscode';
import { SshConnection } from './types';

// gera id único simples sem dependências externas
function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export class ConnectionManager {
  private ctx: vscode.ExtensionContext;

  constructor(ctx: vscode.ExtensionContext) {
    this.ctx = ctx;
  }

  getAll(): SshConnection[] {
    const cfg = vscode.workspace.getConfiguration('sshSync');
    return cfg.get<SshConnection[]>('connections', []);
  }

  async save(conn: SshConnection): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('sshSync');
    const list = this.getAll().filter(c => c.id !== conn.id);
    list.push(conn);
    await cfg.update('connections', list, vscode.ConfigurationTarget.Global);
  }

  async remove(id: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('sshSync');
    const list = this.getAll().filter(c => c.id !== id);
    await cfg.update('connections', list, vscode.ConfigurationTarget.Global);
    await this.ctx.secrets.delete(`sshSync.pw.${id}`);
  }

  async savePassword(id: string, pw: string): Promise<void> {
    await this.ctx.secrets.store(`sshSync.pw.${id}`, pw);
  }

  async getPassword(id: string): Promise<string | undefined> {
    return this.ctx.secrets.get(`sshSync.pw.${id}`);
  }

  // abre wizard para criar nova ligação
  async promptNewConnection(): Promise<SshConnection | undefined> {
    // valida localBasePath ANTES de pedir qualquer dado ao utilizador
    const localBase = vscode.workspace.getConfiguration('sshSync').get<string>('localBasePath', '');
    if (!localBase) {
      const resp = await vscode.window.showErrorMessage(
        'pasta local base não configurada. define "sshSync.localBasePath" nas definições primeiro.',
        'abrir definições',
      );
      if (resp === 'abrir definições') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'sshSync.localBasePath');
      }
      return;
    }

    const label = await vscode.window.showInputBox({ prompt: 'nome da ligação', placeHolder: 'servidor prod' });
    if (!label) return;

    const host = await vscode.window.showInputBox({ prompt: 'host ou ip', placeHolder: '192.168.1.10' });
    if (!host) return;

    const portStr = await vscode.window.showInputBox({ prompt: 'porta ssh', value: '22' });
    const port = parseInt(portStr || '22', 10);

    const username = await vscode.window.showInputBox({ prompt: 'utilizador' });
    if (!username) return;

    const password = await vscode.window.showInputBox({ prompt: 'password', password: true });
    if (password === undefined) return;

    const remotePath = await vscode.window.showInputBox({ prompt: 'pasta remota', placeHolder: '/var/www/projeto' });
    if (!remotePath) return;

    const id = genId();
    const conn: SshConnection = {
      id, label, host, port, username,
      remotePath,
      localPath: `${localBase}\\${label.replace(/[^a-z0-9_-]/gi, '_')}`,
    };

    await this.save(conn);
    await this.savePassword(id, password);
    return conn;
  }

  // pede password existente ou solicita ao utilizador
  async resolvePassword(conn: SshConnection): Promise<string | undefined> {
    let pw = await this.getPassword(conn.id);
    if (!pw) {
      pw = await vscode.window.showInputBox({
        prompt: `password para ${conn.username}@${conn.host}`,
        password: true,
      });
      if (pw) await this.savePassword(conn.id, pw);
    }
    return pw;
  }
}
