import { EventEmitter } from 'events';
import type { AgentRuntimeMode, AgentSystemPromptMode, AgentToolMode, DB, SessionRow } from './db';

interface CreateSessionOptions {
  name?: string;
  agentId?: string;
  id?: string;
  process_start_tag?: string;
  process_end_tag?: string;
  runtime_mode?: AgentRuntimeMode;
  system_prompt_mode?: AgentSystemPromptMode;
  tool_mode?: AgentToolMode;
}

export class SessionManager extends EventEmitter {
  private db: DB;

  constructor(db: DB) {
    super();
    this.db = db;
    this.ensureDefaultSession();
  }

  private ensureDefaultSession() {
    const sessions = this.db.getSessions();
    if (sessions.length === 0) {
      this.createSession({
        id: this.generateId(),
        name: '综合管家',
        agentId: 'main',
      });
    }
  }

  createSession(options: CreateSessionOptions = {}): SessionRow {
    const id = options.id || this.generateId();
    const now = Date.now();
    
    // Check if name is provided, otherwise generate default
    let name = options.name;
    if (!name) {
      const allSessions = this.db.getSessions();
      name = `Session ${allSessions.length + 1}`;
    }

    const allSessions = this.db.getSessions();
    const maxPos = allSessions.length > 0 ? Math.max(...allSessions.map(s => s.position || 0)) : -1;
    const position = maxPos + 1;

    let finalAgentId = options.agentId || id;

    const session: SessionRow = {
      id,
      name,
      agentId: finalAgentId,
      position,
      created_at: now,
      updated_at: now,
      process_start_tag: options.process_start_tag || '',
      process_end_tag: options.process_end_tag || '',
      runtime_mode: options.runtime_mode || 'configured',
      system_prompt_mode: options.system_prompt_mode || 'system',
      tool_mode: options.tool_mode || 'full',
    };
    
    this.db.saveSession(session);
    this.emit('sessionCreated', session);
    
    return session;
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.getSession(id);
  }

  getAllSessions(): SessionRow[] {
    return this.db.getSessions();
  }

  updateSession(id: string, updates: Partial<Omit<SessionRow, 'id' | 'created_at'>>): SessionRow | undefined {
    const session = this.db.getSession(id);
    if (!session) return undefined;
    
    const updated: SessionRow = {
      ...session,
      ...updates,
      updated_at: Date.now()
    };
    
    this.db.saveSession(updated);
    this.emit('sessionUpdated', updated);
    
    return updated;
  }

  deleteSession(id: string): boolean {
    const session = this.db.getSession(id);
    if (!session) return false;
    
    // Optional logic: never let them delete the strictly LAST session, 
    // but the DB cascading lets us just delete it. We'll allow it.
    this.db.deleteSession(id);
    this.emit('sessionDeleted', session);
    
    // Re-ensure default if we deleted everything
    this.ensureDefaultSession();
    
    return true;
  }

  reorderSessions(ids: string[]): void {
    const orders = ids.map((id, index) => ({
      id,
      position: index
    }));
    this.db.updateSessionPositions(orders);
    this.emit('sessionsReordered', ids);
  }

  incrementMessageCount(id: string): void {
    const session = this.db.getSession(id);
    if (session) {
      session.updated_at = Date.now();
      this.db.saveSession(session);
    }
  }

  private generateId(): string {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  }
}

export default SessionManager;
