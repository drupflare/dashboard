import { generateSigningKey, newId, type SigningKey } from '../../contracts/src/common';
import {
	FLEET_LINK_VERSION,
	challengeSchema,
	claimResponseSchema,
	signChallengeResponse,
	signEnvelope,
	verifyEnvelope,
	type CommandEnvelope,
	type NodeEnvelope,
	type ServerEnvelope,
	type SitesEnvelope,
	type UnsignedEnvelope
} from '../../contracts/src/fleet-link';

export type Fault = {
	// send the sequence number of the previous message again
	replay?: true;
	seq?: number;
	// move the timestamp by this many milliseconds
	skewMs?: number;
	// flip the signature, or leave it out
	badSignature?: true;
	unsigned?: true;
};

export interface FakeNodeOptions {
	now?: () => number;
	// the newest contract minor the box announces; 0 is a box that predates the site map frame
	minor?: number;
	hostFacts?: Partial<ReturnType<typeof defaultFacts>>;
}

const defaultFacts = () => ({
	hostname: 'box-1',
	os: 'linux',
	arch: 'arm64',
	bastionVersion: '0.1.0',
	workerdVersion: '1.20260101.0',
	mode: 'standalone'
});

type Body<T extends NodeEnvelope['type']> = Extract<NodeEnvelope, { type: T }>['body'];

// a box that speaks the fleet link: claim, answer the challenge, send signed messages with a rising
// sequence number, and read signed commands. Every method returns text a socket can carry
export class FakeNode {
	nodeId: string | null = null;
	dashboardPublicKey: string | null = null;
	seq = -1;

	private constructor(
		readonly key: SigningKey,
		readonly hostFacts: ReturnType<typeof defaultFacts>,
		private readonly now: () => number,
		readonly minor: number
	) {}

	static async create(options: FakeNodeOptions = {}): Promise<FakeNode> {
		return new FakeNode(
			await generateSigningKey(),
			{ ...defaultFacts(), ...options.hostFacts },
			options.now ?? Date.now,
			options.minor ?? 0
		);
	}

	claimBody(claimToken: string) {
		return { claimToken, nodePublicKey: this.key.publicKey, hostFacts: this.hostFacts };
	}

	adopt(response: unknown): void {
		const parsed = claimResponseSchema.parse(response);
		this.nodeId = parsed.nodeId;
		this.dashboardPublicKey = parsed.dashboardPublicKey;
	}

	private id(): string {
		if (this.nodeId === null) throw new Error('the fake node has not been claimed');
		return this.nodeId;
	}

	async answerChallenge(
		frame: string,
		fault: {
			skewMs?: number;
			badSignature?: true;
			wrongNonce?: true;
			unsupportedRange?: true;
		} = {}
	): Promise<string> {
		const challenge = challengeSchema.parse(JSON.parse(frame));
		const max = FLEET_LINK_VERSION.major + (fault.unsupportedRange ? 1 : 0);
		const minMajor = fault.unsupportedRange ? max : FLEET_LINK_VERSION.major;
		const response = await signChallengeResponse(
			{
				nodeId: this.id(),
				nonce: fault.wrongNonce ? 'A'.repeat(22) : challenge.nonce,
				ts: this.now() + (fault.skewMs ?? 0),
				range: {
					min: { major: minMajor, minor: 0 },
					max: { major: max, minor: fault.unsupportedRange ? 0 : this.minor }
				}
			},
			this.key.privateKey
		);
		return JSON.stringify(
			fault.badSignature ? { ...response, sig: flip(response.sig) } : response
		);
	}

	async message<T extends NodeEnvelope['type']>(
		type: T,
		body: Body<T>,
		fault: Fault = {}
	): Promise<string> {
		const seq = fault.seq ?? (fault.replay ? this.seq : ++this.seq);
		const unsigned = {
			v: FLEET_LINK_VERSION.major,
			id: `msg_${crypto.randomUUID().replaceAll('-', '')}`,
			type,
			ts: this.now() + (fault.skewMs ?? 0),
			seq,
			ack: 0,
			body
		} as UnsignedEnvelope;
		const signed = await signEnvelope(unsigned, this.key.privateKey);
		if (fault.unsigned) {
			const { sig: _sig, ...rest } = signed;
			return JSON.stringify(rest);
		}
		return JSON.stringify(fault.badSignature ? { ...signed, sig: flip(signed.sig) } : signed);
	}

	status(fault?: Fault, overrides: Partial<Body<'status'>> = {}): Promise<string> {
		return this.message(
			'status',
			{
				...this.hostFacts,
				nodeId: this.id() as Body<'status'>['nodeId'],
				tenants: ['t1'],
				sites: ['s1'],
				namesHashed: false,
				capacity: { sites: 1 },
				...overrides
			},
			fault
		);
	}

	findings(
		findings: Body<'findings'>['findings'] = [{ code: 'update.pending', site: 's1', count: 1 }],
		fault?: Fault
	): Promise<string> {
		return this.message('findings', { findings }, fault);
	}

	auditHead(seq: number, hash: string, fault?: Fault): Promise<string> {
		return this.message('audit.head', { seq, hash }, fault);
	}

	commandResult(
		command: CommandEnvelope,
		outcome: Body<'command.result'>['outcome'] = 'succeeded',
		fault?: Fault
	): Promise<string> {
		return this.message(
			'command.result',
			{
				opId: command.body.opId,
				stepId: command.body.stepId,
				idempotencyKey: command.body.idempotencyKey,
				outcome,
				code: null,
				deploy: null
			},
			fault
		);
	}

	// verifies a frame from the server as the bastion client will: pinned dashboard key, the node's
	// own id and the timestamp window
	async readCommand(frame: string, seen?: ReadonlySet<string>): Promise<CommandEnvelope> {
		return (await this.readFrame(frame, seen)) as CommandEnvelope;
	}

	async readSites(frame: string, seen?: ReadonlySet<string>): Promise<SitesEnvelope> {
		return (await this.readFrame(frame, seen)) as SitesEnvelope;
	}

	private async readFrame(frame: string, seen?: ReadonlySet<string>): Promise<ServerEnvelope> {
		if (this.dashboardPublicKey === null) throw new Error('the fake node has not been claimed');
		const verdict = await verifyEnvelope(JSON.parse(frame), {
			publicKey: this.dashboardPublicKey,
			direction: 'server',
			now: this.now(),
			nodeId: this.id(),
			...(seen === undefined ? {} : { seen })
		});
		if (!verdict.ok) throw new Error(`command refused: ${verdict.code}`);
		return verdict.value as ServerEnvelope;
	}
}

function flip(sig: string): string {
	return (sig.startsWith('A') ? 'B' : 'A') + sig.slice(1);
}

export const newNodeId = (): string => newId('nod');
