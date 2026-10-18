
export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt?: Date;
}

export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    if (
      typeof props.messageId !== 'string' ||
      !props.messageId.trim() ||
      props.messageId.length > 255
    ) {
      throw new Error('Invalid inbox messageId');
    }

    if (
      typeof props.consumerName !== 'string' ||
      !props.consumerName.trim() ||
      props.consumerName.length > 100
    ) {
      throw new Error('Invalid inbox consumerName');
    }

    if (!/^[a-f0-9]{64}$/.test(props.payloadHash)) {
      throw new Error('Invalid inbox payloadHash');
    }

    const receivedAt = props.receivedAt ?? new Date();

    if (
      !(receivedAt instanceof Date) ||
      Number.isNaN(receivedAt.getTime())
    ) {
      throw new Error('Invalid inbox receivedAt');
    }

    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      new Date(receivedAt.getTime()),
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    const message = InboxMessage.receive({
      messageId: state.messageId,
      consumerName: state.consumerName,
      payloadHash: state.payloadHash,
      receivedAt: state.receivedAt,
    });

    if (state.processedAt !== undefined) {
      if (
        !(state.processedAt instanceof Date) ||
        Number.isNaN(state.processedAt.getTime())
      ) {
        throw new Error('Invalid inbox processedAt');
      }

      if (state.processedAt.getTime() < message.receivedAt.getTime()) {
        throw new Error('Inbox processedAt cannot precede receivedAt');
      }

      message._processedAt = new Date(state.processedAt.getTime());
    }

    return message;
  }

  get processedAt(): Date | undefined {
    return this._processedAt
      ? new Date(this._processedAt.getTime())
      : undefined;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
      throw new Error('Invalid inbox processedAt');
    }

    if (at.getTime() < this.receivedAt.getTime()) {
      throw new Error('Inbox processedAt cannot precede receivedAt');
    }

    if (this.isProcessed()) {
      throw new Error('Inbox message is already processed');
    }

    this._processedAt = new Date(at.getTime());
  }
}
