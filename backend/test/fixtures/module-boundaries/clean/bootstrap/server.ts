import { registerThingRoutes } from '../control';
import { roomService } from '../collab/rooms';

export function start(): void {
  registerThingRoutes();
  roomService();
}
