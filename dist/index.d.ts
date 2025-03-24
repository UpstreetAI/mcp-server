declare class SimpleMcpServer {
    private serversJson;
    private port;
    private internalPortStart;
    constructor({ serversJson, port, internalPortStart, }: {
        serversJson: any;
        port?: number;
        internalPortStart?: number;
    });
    start(): Promise<void>;
}

export { SimpleMcpServer as default };
