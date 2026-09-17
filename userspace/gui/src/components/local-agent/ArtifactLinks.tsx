import { t } from '../../i18n';
import { useUiLanguage } from '../../useUiLanguage';
import React from 'react';
import type { ArtifactProjection } from '@deepcode/protocol';
import { workspaceResourceLink } from './documentResources';
import { requestReader } from './readerState';
import { useConversationHost } from './ConversationHost';

export function ArtifactLinks({ artifacts, onOpen }: { artifacts: readonly ArtifactProjection[]; onOpen(workspaceId: string, logicalPath: string): Promise<void> }) {
  const host = useConversationHost();
  const [error, setError] = React.useState<string | null>(null);
  return <div className="document-artifacts">
    {artifacts.map((artifact) => {
      const fixed = artifact.contentMode === 'fixed';
      const resource = artifact.workspaceId && artifact.logicalPath
        ? { workspaceId: artifact.workspaceId, logicalPath: artifact.logicalPath }
        : workspaceResourceLink(artifact.uri ?? '');
      const external = /^https?:\/\//i.test(artifact.uri ?? '') ? artifact.uri : null;
      const imagePreview = artifact.contentType.startsWith('image/') && fixed;
      const label = artifact.label.split(/[\\/]/u).at(-1) ?? artifact.label;
      const location = artifact.logicalPath ?? artifact.uri ?? artifact.label;
      const content = imagePreview
        ? <ArtifactImage artifact={artifact} />
        : <><strong title={location}>{label}</strong><time>{formatArtifactTime(artifact.createdAt)}</time></>;
      return fixed || resource || external ? <button type="button" className="deepcode-gui-output-item document-artifacts__item" key={artifact.artifactId}
        aria-label={imagePreview ? label : undefined} title={imagePreview ? location : undefined}
        onClick={() => { setError(null); if(fixed) {requestReader(artifact.sessionId,{kind:'artifact',artifact});return;} void (resource ? onOpen(resource.workspaceId, resource.logicalPath) : host.openExternalLink(external!))
          .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))); }}>{content}</button>
        : <div className="deepcode-gui-output-item" key={artifact.artifactId}>{content}</div>;
    })}
    {error && <p role="alert" className="local-agent__resource-error">{error}</p>}
  </div>;
}

function ArtifactImage({artifact}:{artifact:ArtifactProjection}) {
  const language = useUiLanguage();
  const host=useConversationHost();
  const [url,setUrl]=React.useState('');
  const [error,setError]=React.useState<string|null>(null);
  React.useEffect(()=>{
    const controller=new AbortController();let release:(()=>void)|undefined;
    setUrl('');setError(null);
    void host.loadImage(artifact.sessionId,`artifact://${artifact.artifactId}`,controller.signal).then((result)=>{
      if(controller.signal.aborted){result.release?.();return;}release=result.release;setUrl(result.url);
    }).catch((reason:unknown)=>{if(!controller.signal.aborted)setError(String(reason));});
    return ()=>{controller.abort();release?.();};
  },[artifact.sessionId,artifact.artifactId,host]);
  return error ? <span role="alert">{error}</span> : url ? <img className="document-artifact-image" src={url} alt={artifact.label}/> : <span>{t(language, 'reader.imageLoading')}</span>;
}

function formatArtifactTime(value: string): string {
  const date = new Date(/^\d+$/u.test(value) ? Number(value) : value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
