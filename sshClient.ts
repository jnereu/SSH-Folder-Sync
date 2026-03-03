import * as vscode from 'vscode';
import * as ssh2 from 'ssh2';
import * as fs from 'fs';
import * as path from 'path';
import { SshConnection, RemoteEntry } from './types';

export class SshClient {
  private client: ssh2.Client;
  private sftp: ssh2.SFTPWrapper | null = null;
  public connected = false;

  constructor() {
    this.client = new ssh2.Client();
  }

  async connect(conn: SshConnection, password: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client
        .on('ready', () => {
          this.client.sftp((err, sftp) => {
            if (err) { reject(err); return; }
            this.sftp = sftp;
            this.connected = true;
            resolve();
          });
        })
        .on('error', reject)
        .connect({
          host:     conn.host,
          port:     conn.port,
          username: conn.username,
          password,
        });
    });
  }

  disconnect() {
    this.client.end();
    this.connected = false;
    this.sftp = null;
  }

  private getSftp(): ssh2.SFTPWrapper {
    if (!this.sftp) throw new Error('sem ligação sftp activa');
    return this.sftp;
  }

  // verifica se pasta/ficheiro remoto existe
  async exists(remotePath: string): Promise<boolean> {
    const sftp = this.getSftp();
    return new Promise(resolve => {
      sftp.stat(remotePath, err => resolve(!err));
    });
  }

  async listDir(remotePath: string): Promise<RemoteEntry[]> {
    const sftp = this.getSftp();

    // verifica se a pasta existe antes de listar
    const ok = await this.exists(remotePath);
    if (!ok) {
      throw new Error(`pasta remota não encontrada: ${remotePath}`);
    }

    return new Promise((resolve, reject) => {
      sftp.readdir(remotePath, (err, list) => {
        if (err) { reject(err); return; }
        const entries: RemoteEntry[] = list.map(item => ({
          name:     item.filename,
          fullPath: `${remotePath}/${item.filename}`.replace(/\/\//g, '/'),
          isDir:    (item.attrs.mode & 0o170000) === 0o040000,
          size:     item.attrs.size,
          modTime:  new Date(item.attrs.mtime * 1000),
        }));
        resolve(entries);
      });
    });
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    const sftp = this.getSftp();
    await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
    return new Promise((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, {}, err => err ? reject(err) : resolve());
    });
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    const sftp = this.getSftp();
    await this.mkdirRemote(path.dirname(remotePath));
    return new Promise((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, {}, err => err ? reject(err) : resolve());
    });
  }

  async readRemoteFile(remotePath: string): Promise<string> {
    const sftp = this.getSftp();
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = sftp.createReadStream(remotePath);
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });
  }

  async stat(remotePath: string): Promise<ssh2.Stats | null> {
    const sftp = this.getSftp();
    return new Promise(resolve => {
      sftp.stat(remotePath, (err, stats) => resolve(err ? null : stats));
    });
  }

  private async mkdirRemote(remotePath: string): Promise<void> {
    const sftp = this.getSftp();
    const parts = remotePath.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current += '/' + part;
      await new Promise<void>(resolve => {
        sftp.mkdir(current, () => resolve());
      });
    }
  }

  async downloadDir(
    remotePath: string,
    localPath: string,
    progress?: vscode.Progress<{ message?: string }>,
  ): Promise<void> {
    // verifica se pasta remota existe antes de tentar descarregar
    const ok = await this.exists(remotePath);
    if (!ok) {
      throw new Error(`pasta remota não encontrada: ${remotePath}`);
    }

    const entries = await this.listDir(remotePath);
    for (const entry of entries) {
      const localEntry = path.join(localPath, entry.name);
      if (entry.isDir) {
        await fs.promises.mkdir(localEntry, { recursive: true });
        await this.downloadDir(entry.fullPath, localEntry, progress);
      } else {
        progress?.report({ message: entry.name });
        await this.downloadFile(entry.fullPath, localEntry);
      }
    }
  }
}
