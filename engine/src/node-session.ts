import { fromBase64Url, signingKeyFromSeed } from '@contracts/common';
import { DurableObject } from 'cloudflare:workers';
import type { CommandRequest } from '../../src/server/domain/fleet';
import { D1BoxSiteStore } from './box-site-store';
import type { EngineEnv } from './env';
import {
	CLOSE,
	HANDSHAKE_MS,
	NodeLink,
	linkNodeId,
	type CommandStatus,
	type LinkSocket,
	type SendResult,
	type SocketState
} from './node-link';
import { D1NodeStore } from './node-store';

function socketOf(ws: WebSocket): LinkSocket {
	return {
		send: (text) => ws.send(text),
		close: (code, reason) => ws.close(code, reason),
		readState: () => ws.deserializeAttachment() as SocketState | null,
		writeState: (state) => ws.serializeAttachment(state)
	};
}

export class NodeSession extends DurableObject<EngineEnv> {
	private cached: NodeLink | undefined;
	private key: Promise<CryptoKey> | undefined;

	private link(): NodeLink {
		this.cached ??= new NodeLink({
			nodes: new D1NodeStore(this.env.DB),
			boxSites: new D1BoxSiteStore(this.env.DB, this.env.BLOB),
			storage: this.ctx.storage.kv,
			now: Date.now,
			signingKey: () => {
				this.key ??= signingKeyFromSeed(fromBase64Url(this.env.FLEET_SEED)).then(
					(pair) => pair.privateKey
				);
				return this.key;
			},
			sockets: () => this.ctx.getWebSockets().map(socketOf)
		});
		return this.cached;
	}

	override async fetch(request: Request): Promise<Response> {
		const nodeId = linkNodeId(new URL(request.url));
		if (nodeId === null || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
			return new Response(null, { status: 400 });
		}
		// one live socket per node; a box that reconnects replaces its old connection
		for (const old of this.ctx.getWebSockets()) old.close(CLOSE.replaced, 'replaced');
		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		this.ctx.acceptWebSocket(server);
		this.link().open(socketOf(server), nodeId);
		await this.ctx.storage.setAlarm(Date.now() + HANDSHAKE_MS);
		return new Response(null, { status: 101, webSocket: client });
	}

	override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		await this.link().message(socketOf(ws), message);
	}

	override webSocketClose(ws: WebSocket): void {
		ws.close(1000, 'closed');
	}

	override async alarm(): Promise<void> {
		const next = await this.link().tick();
		if (next !== null) await this.ctx.storage.setAlarm(next);
	}

	sendCommand(nodeId: string, request: CommandRequest): Promise<SendResult> {
		return this.link().sendCommand(nodeId, request);
	}

	commandStatus(ref: { opId: string; stepId: string; idempotencyKey: string }): CommandStatus {
		return this.link().commandStatus(ref);
	}
}
