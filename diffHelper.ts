import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SshClient } from './sshClient';

// mostra diff entre ficheiro local e versão remota
export async function showDiff(
  client: SshClient,
  localPath: string,
  remotePath: string,
): Promise<void> {
  // verifica se ficheiro local existe
  if (!fs.existsSync(localPath)) {
    vscode.window.showWarningMessage('ficheiro local não encontrado — descarrega primeiro');
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'a carregar versão remota…' },
    async () => {
      // guarda conteúdo remoto em ficheiro temporário
      const content = await client.readRemoteFile(remotePath);
      const tmpDir  = os.tmpdir();
      const tmpFile = path.join(tmpDir, `ssh-sync-remote-${path.basename(remotePath)}`);
      await fs.promises.writeFile(tmpFile, content, 'utf8');

      const localUri  = vscode.Uri.file(localPath);
      const remoteUri = vscode.Uri.file(tmpFile);
      const title     = `local ↔ remoto: ${path.basename(remotePath)}`;

      await vscode.commands.executeCommand('vscode.diff', localUri, remoteUri, title);
    },
  );
}
