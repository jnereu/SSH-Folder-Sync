import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SshClient } from './sshClient';
import { SshConnection, RemoteEntry } from './types';

// --- explorador de ligações ---

export class ConnectionsProvider implements vscode.TreeDataProvider<ConnItem> {
  private _onDidChange = new vscode.EventEmitter<ConnItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(
    private connections: SshConnection[],
    private activeId: string | null,
  ) {}

  refresh(connections: SshConnection[], activeId: string | null) {
    this.connections = connections;
    this.activeId = activeId;
    this._onDidChange.fire();
  }

  getTreeItem(el: ConnItem) { return el; }

  getChildren(): ConnItem[] {
    return this.connections.map(c => new ConnItem(c, c.id === this.activeId));
  }
}

export class ConnItem extends vscode.TreeItem {
  constructor(
    public readonly conn: SshConnection,
    isActive: boolean,
  ) {
    super(conn.label, vscode.TreeItemCollapsibleState.None);
    this.description = `${conn.username}@${conn.host}:${conn.remotePath}`;
    this.contextValue = isActive ? 'activeConn' : 'inactiveConn';
    this.iconPath = new vscode.ThemeIcon(isActive ? 'vm-running' : 'vm');
    this.command = {
      command: 'sshSync.connect',
      title: 'ligar',
      arguments: [conn],
    };
  }
}

// --- explorador de ficheiros remotos ---

export class RemoteFilesProvider implements vscode.TreeDataProvider<FileItem> {
  private _onDidChange = new vscode.EventEmitter<FileItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private client: SshClient | null = null;
  private conn: SshConnection | null = null;

  setClient(client: SshClient | null, conn: SshConnection | null) {
    this.client = client;
    this.conn = conn;
    this._onDidChange.fire();
  }

  refresh() { this._onDidChange.fire(); }

  getTreeItem(el: FileItem) { return el; }

  async getChildren(parent?: FileItem): Promise<FileItem[]> {
    if (!this.client || !this.conn) return [];

    const remotePath = parent ? parent.remotePath : this.conn.remotePath;
    const localBase  = parent ? parent.localPath  : this.conn.localPath;

    try {
      const entries = await this.client.listDir(remotePath);
      return entries.map(e => new FileItem(e, localBase, this.conn!));
    } catch {
      return [];
    }
  }
}

export class FileItem extends vscode.TreeItem {
  readonly remotePath: string;
  readonly localPath: string;

  constructor(entry: RemoteEntry, localParent: string, conn: SshConnection) {
    super(
      entry.name,
      entry.isDir
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    this.remotePath = entry.fullPath;
    this.localPath  = path.join(localParent, entry.name);

    const localExists = fs.existsSync(this.localPath);

    if (!entry.isDir) {
      this.contextValue = 'remoteFile';
      this.description  = localExists ? '✓ local' : '↓ remoto';
      this.iconPath     = new vscode.ThemeIcon(localExists ? 'file' : 'cloud-download');
      this.command = localExists ? {
        command: 'vscode.open',
        title: 'abrir',
        arguments: [vscode.Uri.file(this.localPath)],
      } : undefined;
      this.tooltip = `${entry.size} bytes · ${entry.modTime.toLocaleString()}`;
    } else {
      this.contextValue = 'remoteDir';
      this.iconPath = new vscode.ThemeIcon('folder');
    }
  }
}
