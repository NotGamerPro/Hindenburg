import winston from "winston";
import * as uuid from "uuid";

import {
    Color,
    DisconnectReason,
    GameOverReason,
    GameState
} from "@skeldjs/constant";

import {
    BaseGameDataMessage,
    BaseRootMessage,
    EndGameMessage,
    GameDataMessage,
    GameDataToMessage,
    GameOptions,
    HostGameMessage,
    JoinedGameMessage,
    JoinGameMessage,
    ReliablePacket,
    RemoveGameMessage,
    RemovePlayerMessage,
    SceneChangeMessage,
    StartGameMessage,
    UnreliablePacket,
    WaitForHostMessage
} from "@skeldjs/protocol";

import { Code2Int, Int2Code, sleep } from "@skeldjs/util";

import { Hostable, PlayerData } from "@skeldjs/core";

import { Client } from "./Client";
import { WorkerNode } from "./WorkerNode";
import { Anticheat } from "./Anticheat";
import { fmtName } from "./util/format-name";
import chalk from "chalk";

export enum SpecialId {
    Nil = 0,
    SaaH = -1,
    Everyone = -2
}

export class Room extends Hostable {
    logger: winston.Logger;

    uuid: string;

    code: number;
    clients: Map<number, Client>;
    settings: GameOptions;
    state: GameState;
    
    waiting: Set<Client>;

    anticheat: Anticheat;

    constructor(private server: WorkerNode, public readonly SaaH: boolean) {
        super({ doFixedUpdate: true });

        this.uuid = uuid.v4();

        this.code = 0;
        this.clients = new Map;
        this.settings = new GameOptions;
        this.state = GameState.NotStarted;
        
        this.waiting = new Set;

        this.anticheat = new Anticheat(this.server, this);
        
        this.logger = winston.createLogger({
            transports: [
                new winston.transports.Console({
                    format: winston.format.combine(
                        winston.format.splat(),
                        winston.format.colorize(),
                        winston.format.printf(info => {
                            return `[${this.name}] ${info.level}: ${info.message}`;
                        }),
                    ),
                }),
                new winston.transports.File({
                    filename: "logs/" + this.uuid + ".txt",
                    format: winston.format.combine(
                        winston.format.splat(),
                        winston.format.simple()
                    )
                })
            ]
        });

        this.on("player.setname", setname => {
            this.logger.info(
                "Player %s set their name to %s.",
                fmtName(setname.player), setname.name
            );
        });
        
        this.on("player.setcolor", setcolor => {
            this.logger.info(
                "Player %s set their color to %s.",
                fmtName(setcolor.player), Color[setcolor.color]
            );
        });

        if (SaaH) {
            this.setHost(SpecialId.SaaH);
        }
    }

    get amhost() {
        return this.hostid === SpecialId.SaaH;
    }

    get name() {
        return Int2Code(this.code);
    }

    get destroyed() {
        return this.state === GameState.Destroyed;
    }

    async destroy() {
        super.destroy();

        await this.broadcast([], true, null, [
            new RemoveGameMessage(DisconnectReason.Destroy)
        ]);

        this.state = GameState.Destroyed;
        this.server.rooms.delete(this.code);

        await this.server.redis.del("room." + this.name);

        this.logger.info("Room was destroyed.");
    }

    async broadcast(
        messages: BaseGameDataMessage[]|((client: Client) => BaseGameDataMessage[])|null,
        reliable: boolean = true,
        recipient: PlayerData | null = null,
        payloads: BaseRootMessage[] = []
    ) {
        if (recipient) {
            const remote = this.clients.get(recipient.id);

            if (remote) {
                const children = [
                    ...(messages?.length ? [new GameDataToMessage(
                        this.code,
                        remote.clientid,
                        typeof messages === "function" ? messages(remote) : messages
                    )] : []),
                    ...payloads
                ];
                
                if (!children.length)
                    return;

                await remote.send(
                    reliable
                        ? new ReliablePacket(remote.getNextNonce(), children)
                        : new UnreliablePacket(children)
                );
            }
        } else {
            await Promise.all(
                [...this.clients]
                    // .filter(([, client]) => !exclude.includes(client))
                    .map(([, client]) => {
                        const children = [
                            ...(messages?.length ? [new GameDataMessage(
                                this.code,
                                typeof messages === "function" ? messages(client) : messages
                            )] : []),
                            ...payloads
                        ];

                        if (!children.length)
                            return Promise.resolve();
                        
                        return client.send(
                            reliable
                                ? new ReliablePacket(client.getNextNonce(), children)
                                : new UnreliablePacket(children)
                        ).then(()=>{});
                    })
            );
        }
    }

    async setCode(code: number|string): Promise<void> {
        if (typeof code === "string") {
            return this.setCode(Code2Int(code));
        }

        if (this.code) {
            this.logger.info(
                "Game code changed to [%s]",
                Int2Code(code) 
            );
        }

        super.setCode(code);

        await this.broadcast([], true, null, [
            new HostGameMessage(code)
        ]);
    }

    async updateHost(client: Client|number) {
        const clientid = typeof client == "number"
            ? client
            : client.clientid;

        if (clientid === SpecialId.Everyone) {
            await Promise.all(
                [...this.clients]
                    // .filter(([, client]) => !exclude.includes(client))
                    .map(([, client]) => {
                        return client.send(
                            new ReliablePacket(
                                client.getNextNonce(),
                                [
                                    new JoinGameMessage(
                                        this.code,
                                        SpecialId.Nil,
                                        client.clientid
                                    ),
                                    new RemovePlayerMessage(
                                        this.code,
                                        SpecialId.Nil,
                                        DisconnectReason.None,
                                        client.clientid
                                    )
                                ]
                            )
                        )
                    })
            );
        } else {
            await this.broadcast([], true, null, [
                new JoinGameMessage(
                    this.code,
                    SpecialId.Nil,
                    clientid
                ),
                new RemovePlayerMessage(
                    this.code,
                    SpecialId.Nil,
                    DisconnectReason.None,
                    clientid
                )
            ]);
        }
    }

    async setHost(player: PlayerData|SpecialId.SaaH) {
        const playerid = typeof player === "number"
            ? player
            : player.id;

        const remote = this.clients.get(playerid);

        await super.setHost(player);

        if (remote && this.state === GameState.Ended && this.waiting.has(remote)) {
            await this.handleRemoteJoin(remote);
        }

        this.logger.info(
            "Host changed to %s",
            player === SpecialId.SaaH ? chalk.yellow("[Server]") : fmtName(player)
        );
    }

    async handleRemoteLeave(client: Client, reason: DisconnectReason = DisconnectReason.None) {
        await super.handleLeave(client.clientid);

        this.clients.delete(client.clientid);

        if (this.clients.size === 0) {
            await this.destroy();
            return;
        }

        await this.setHost([...this.players.values()][0]);

        if (this.SaaH) {

        } else {

        }

        await this.broadcast([], true, null, [
            new RemovePlayerMessage(
                this.code,
                client.clientid,
                reason,
                this.host.id
            )
        ]);

        this.logger.info(
            "Client with ID %s left or was removed.",
            client.clientid
        );
    }

    async handleRemoteJoin(client: Client) {
        const player = await super.handleJoin(client.clientid);
        
        if (!this.host && !this.SaaH)
            await this.setHost(player);

        client.room = this;

        if (this.state === GameState.Ended) {
            await this.broadcast([], true, null, [
                new JoinGameMessage(
                    this.code,
                    client.clientid,
                    this.host.id
                )
            ]);

            if (client.clientid === this.hostid) {
                this.state = GameState.NotStarted;
                
                for (const [ , client ] of this.clients) {
                    if (!this.waiting.has(client)) {
                        this.clients.delete(client.clientid);
                    }
                }

                await Promise.all(
                    [...this.waiting].map(waiting => {
                        return waiting.send(
                            new JoinedGameMessage(
                                this.code,
                                client.clientid,
                                this.host.id,
                                [...this.clients]
                                    .map(([, client]) => client.clientid)
                            )
                        );
                    })
                );
            } else {
                this.waiting.add(client);
                await client.send(
                    new ReliablePacket(
                        client.getNextNonce(),
                        [
                            new WaitForHostMessage(
                                this.code,
                                client.clientid
                            )
                        ]
                    )
                )
                return;
            }
        }

        if (this.SaaH) await this.updateHost(SpecialId.SaaH);

        await client.send(
            new ReliablePacket(
                client.getNextNonce(),
                [
                    new JoinedGameMessage(
                        this.code,
                        client.clientid,
                        this.hostid,
                        [...this.clients]
                            .map(([, client]) => client.clientid)
                    )
                ]
            )
        );

        await this.broadcast([], true, null, [
            new JoinGameMessage(
                this.code,
                client.clientid,
                this.hostid
            )
        ]);
        
        this.clients.set(client.clientid, client);

        await this.wait("player.spawn");
        await sleep(500);

        if (this.SaaH) await this.updateHost(SpecialId.Everyone);

        this.logger.info(
            "Client with ID %s joined the game.",
            client.clientid
        );
    }

    async handleStart() {
        this.state = GameState.Started;

        await this.broadcast([], true, null, [
            new StartGameMessage(this.code)
        ]);
    }

    async handleEnd(reason: GameOverReason) {
        this.waiting.clear();
        this.state = GameState.Ended;

        await this.broadcast([], true, null, [
            new EndGameMessage(this.code, reason, false)
        ]);
    }
}