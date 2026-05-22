import type { AgentContextAttachment } from '@deepcode/protocol';
import { readDirectoryTree, readFileContent } from '../../services/fileService.js';
import { listPromptLayers, listSkills } from '../../services/agentContextSourceService.js';

export class ContextSourceRegistry {
  async buildPromptText(attachments: AgentContextAttachment[] = []): Promise<string> {
    const promptLayers = listPromptLayers();
    const skills = await listSkills();
    const lines: string[] = [
      'You are DeepCode Agent.',
      'You are a local coding agent constrained by permissions.',
      'Return local operations only as ```deepcode-action JSON blocks``` or model tool calls.',
      'Natural language alone must never imply that a file was written or a shell command was executed.',
      '',
      'Available action types: fs.read, fs.list, fs.diff, fs.write, code.search, patch.plan, shell.propose, shell.exec, final.',
      'Use shell.exec only when execution is necessary; it will run in an Agent-owned temporary shell after approval.',
    ];

    if (promptLayers.layers.length > 0) {
      lines.push('', `Prompt layers: ${promptLayers.layers.map((layer) => layer.title ?? layer.id).join(', ')}`);
    }
    if (skills.skills.length > 0) {
      lines.push('', `Available skills: ${skills.skills.filter((skill) => skill.enabled).map((skill) => skill.name).join(', ')}`);
    }

    for (const attachment of attachments) {
      if (attachment.kind === 'file') {
        try {
          const file = await readFileContent(attachment.folderId, attachment.path);
          lines.push('', `Attached file: ${attachment.path}`, '```', file.content.slice(0, 16000), '```');
        } catch (err) {
          lines.push('', `Attached file unavailable: ${attachment.path} (${err instanceof Error ? err.message : String(err)})`);
        }
      } else {
        try {
          const tree = await readDirectoryTree(attachment.folderId, attachment.path, 2);
          lines.push('', `Attached directory tree: ${attachment.path}`, '```json', JSON.stringify(tree, null, 2).slice(0, 16000), '```');
        } catch (err) {
          lines.push('', `Attached directory unavailable: ${attachment.path} (${err instanceof Error ? err.message : String(err)})`);
        }
      }
    }

    return lines.join('\n');
  }
}
