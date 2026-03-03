// tipos usados em todo o plugin

export interface SshConnection {
  id:         string;
  label:      string;
  host:       string;
  port:       number;
  username:   string;
  remotePath: string;  // pasta raiz no servidor
  localPath:  string;  // pasta local de réplica
}

export interface RemoteEntry {
  name:     string;
  fullPath: string;
  isDir:    boolean;
  size:     number;
  modTime:  Date;
}

export type SyncStatus = 'synced' | 'local_only' | 'remote_only' | 'modified';

export interface FileSyncInfo {
  localPath:   string;
  remotePath:  string;
  status:      SyncStatus;
  localMtime?: Date;
  remoteMtime?: Date;
}
