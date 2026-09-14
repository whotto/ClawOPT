import type { DB } from '../../core/db';
import {
  buildStructuredApiError,
  MODEL_UPDATE_FAILED_ERROR_CODE,
  type RouteApp,
} from '../../core/http';
import type { AgentProvisioner } from './agent-provisioner';
import { withConfigReadFallback } from './agent-settings';

export type CharacterRoutesDeps = {
  agentProvisioner: AgentProvisioner;
  db: DB;
};

export function registerCharacterRoutes(app: RouteApp, ctx: CharacterRoutesDeps): void {
  const { agentProvisioner, db } = ctx;

  app.get('/api/characters', (_req, res) => {
    let configReadFailed = false;
    const characters = db.getCharacters().map(char => {
      const diskSoul = agentProvisioner.readSoul(char.agentId);
      if (diskSoul !== null) {
        char.systemPrompt = diskSoul;
      }
      // Always read the actual model from openclaw.json (source of truth)——但配置读不动
      // 时退回旧的降级行为（保留数据库里已有的 char.model），不让整个列表 500。
      const { value: actualModel, configReadFailed: failed } = withConfigReadFallback(
        null,
        () => agentProvisioner.readAgentModel(char.agentId),
      );
      if (failed) configReadFailed = true;
      if (actualModel) {
        char.model = actualModel;
      }
      return char;
    });
    res.json({ success: true, characters, configReadFailed });
  });

  app.post('/api/characters', async (req, res) => {
    try {
      const char = req.body;
      if (!char.id) char.id = 'char_' + Date.now();

      // Validate agentId
      if (!char.agentId) {
        return res.status(400).json({ success: false, error: '智能体 ID 不能为空' });
      }
      if (/\s/.test(char.agentId)) {
        return res.status(400).json({ success: false, error: '智能体 ID 不允许包含空格' });
      }
      
      // Check for duplicate agentId (excluding the current character being edited)
      const existingChars = db.getCharacters();
      const isDuplicate = existingChars.some(c => c.agentId === char.agentId && c.id !== char.id);
      if (isDuplicate) {
        return res.status(400).json({ success: false, error: `智能体 ID "${char.agentId}" 已存在，请使用其他 ID` });
      }

      // Provision full isolated environment in OpenClaw (workspace, SOUL.md, USER.md, etc.)
      const configChanged = await agentProvisioner.provision({
        agentId: char.agentId,
        soulContent: char.systemPrompt,
        model: char.model,
      });
      
      // Also update SOUL.md if this is an existing character being re-saved
      if (!configChanged) {
        await agentProvisioner.updateSoul(char.agentId, char.systemPrompt);
        // Update model in config if changed
        const modelChanged = await agentProvisioner.updateModel(char.agentId, char.model);
        if (modelChanged) {
          // Gateway auto-reloads config
        }
      }
      
      db.saveCharacter(char);

      if (configChanged) {
          console.log('OpenClaw config changed for new agent, auto-reloading...');
      }

      res.json({ success: true, character: char });
    } catch (err: any) {
      res.status(400).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, err?.message));
    }
  });

  app.delete('/api/characters/:id', async (req, res) => {
    try {
      const character = db.getCharacters().find(c => c.id === req.params.id);
      if (!character) {
        return res.status(404).json({ success: false, error: 'Character not found' });
      }

      db.deleteCharacter(req.params.id);

      // Deprovision agent: remove from OpenClaw config + delete workspace & state dirs
      if (character.agentId && character.agentId !== 'main') {
        const configChanged = await agentProvisioner.deprovision(character.agentId);
        if (configChanged) {
          console.log(`Agent "${character.agentId}" fully removed, gateway auto-reloading...`);
        }
      }

      res.json({ success: true });
    } catch (err: any) {
      console.error('Error deleting character:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // USER.md read/write API for per-character user profile
  app.get('/api/characters/:agentId/user-md', (req, res) => {
    const content = agentProvisioner.readUserMd(req.params.agentId);
    res.json({ success: true, content });
  });

  app.put('/api/characters/:agentId/user-md', (req, res) => {
    const { content } = req.body;
    if (typeof content !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing content' });
    }
    agentProvisioner.writeUserMd(req.params.agentId, content);
    res.json({ success: true });
  });
}
