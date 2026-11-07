import WebSocket from 'ws';
import { assertEndpointUsable, endpointRefusalFromWsError, NATIVE_TOKEN_TYPE, BALANCE_CHECK_TIMEOUT_MS, CancelledError, NetworkError, SyncTimeoutError, type BalanceSummary } from '@kuiralabs/midnight-cli-core';

export type { BalanceSummary } from '@kuiralabs/midnight-cli-core';

interface Utxo {
  value: string;
  owner: string;
  tokenType: string;
  intentHash: string;
  outputIndex: number;
  registeredForDustGeneration: boolean;
}

interface UnshieldedTransaction {
  __typename: 'UnshieldedTransaction';
  transaction: { id: number; hash: string };
  createdUtxos: Utxo[];
  spentUtxos: Utxo[];
}

interface UnshieldedTransactionsProgress {
  __typename: 'UnshieldedTransactionsProgress';
  highestTransactionId: number;
}

type SubscriptionEvent = UnshieldedTransaction | UnshieldedTransactionsProgress;

const SUBSCRIPTION_QUERY = `
  subscription UnshieldedTransactions($address: UnshieldedAddress!) {
    unshieldedTransactions(address: $address) {
      __typename
      ... on UnshieldedTransaction {
        transaction { id hash }
        createdUtxos { value owner tokenType intentHash outputIndex registeredForDustGeneration }
        spentUtxos { value owner tokenType intentHash outputIndex registeredForDustGeneration }
      }
      ... on UnshieldedTransactionsProgress {
        highestTransactionId
      }
    }
  }
`;

/**
 * Check unshielded balance via direct GraphQL WebSocket subscription.
 * Lightweight — no proof server or WalletFacade needed. `signal` cancels it:
 * the connection closes and the check fails with CancelledError.
 */
export function checkBalance(
  address: string,
  indexerWS: string,
  onProgress?: (current: number, highest: number) => void,
  signal?: AbortSignal,
): Promise<BalanceSummary> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) { reject(new CancelledError()); return; }
    assertEndpointUsable(indexerWS);
    const ws = new WebSocket(indexerWS, ['graphql-transport-ws']);

    const utxos = new Map<string, { value: bigint; tokenType: string; spent: boolean; registeredForDustGeneration: boolean }>();
    let txCount = 0;
    let highestTxId = 0;
    let lastSeenTxId = 0;
    let progressReceived = false;
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout>;

    const buildResult = (): BalanceSummary => {
      const balances = new Map<string, bigint>();
      let utxoCount = 0;
      let registeredUtxos = 0;
      let unregisteredUtxos = 0;

      for (const utxo of utxos.values()) {
        if (!utxo.spent) {
          utxoCount++;
          const current = balances.get(utxo.tokenType) ?? 0n;
          balances.set(utxo.tokenType, current + utxo.value);
          // Dust registration only applies to native NIGHT UTXOs.
          if (utxo.tokenType === NATIVE_TOKEN_TYPE) {
            if (utxo.registeredForDustGeneration) registeredUtxos++;
            else unregisteredUtxos++;
          }
        }
      }

      return { balances, utxoCount, txCount, highestTxId, registeredUtxos, unregisteredUtxos };
    };

    const settle = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      settle();
      ws.close();
      reject(new CancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const checkComplete = () => {
      if (!settled && progressReceived && (highestTxId === 0 || lastSeenTxId >= highestTxId)) {
        settled = true;
        settle();
        ws.send(JSON.stringify({ id: '1', type: 'complete' }));
        ws.close();
        resolve(buildResult());
      }
    };

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'connection_init' }));
    });

    ws.on('message', (data: WebSocket.Data) => {
      const message = JSON.parse(data.toString());

      switch (message.type) {
        case 'connection_ack':
          ws.send(JSON.stringify({
            id: '1',
            type: 'subscribe',
            payload: {
              query: SUBSCRIPTION_QUERY,
              variables: { address },
            },
          }));
          break;

        case 'next': {
          if (message.payload?.errors) {
            const errMsg = message.payload.errors[0]?.message || 'Unknown GraphQL error';
            if (!settled) {
              settled = true;
              settle();
              ws.close();
              reject(new Error(`GraphQL error: ${errMsg}`));
            }
            return;
          }

          const event = message.payload?.data?.unshieldedTransactions as SubscriptionEvent;
          if (!event) return;

          if (event.__typename === 'UnshieldedTransaction') {
            txCount++;
            const tx = event as UnshieldedTransaction;
            lastSeenTxId = Math.max(lastSeenTxId, tx.transaction.id);

            for (const utxo of tx.createdUtxos) {
              const key = `${utxo.intentHash}:${utxo.outputIndex}`;
              utxos.set(key, {
                value: BigInt(utxo.value),
                tokenType: utxo.tokenType,
                spent: false,
                registeredForDustGeneration: utxo.registeredForDustGeneration === true,
              });
            }

            for (const utxo of tx.spentUtxos) {
              const key = `${utxo.intentHash}:${utxo.outputIndex}`;
              const existing = utxos.get(key);
              if (existing) {
                existing.spent = true;
              }
            }

            if (onProgress) {
              onProgress(lastSeenTxId, highestTxId);
            }

            checkComplete();
          } else if (event.__typename === 'UnshieldedTransactionsProgress') {
            const progress = event as UnshieldedTransactionsProgress;
            highestTxId = progress.highestTransactionId;
            progressReceived = true;
            checkComplete();
          }
          break;
        }

        case 'error':
          if (!settled) {
            settled = true;
            settle();
            ws.close();
            reject(new Error(`GraphQL subscription error: ${JSON.stringify(message.payload)}`));
          }
          break;

        case 'complete':
          break;
      }
    });

    ws.on('error', (error: Error) => {
      if (!settled) {
        settled = true;
        settle();
        const reason = error.message?.trim()
          ? error.message
          : `unable to reach ${indexerWS} (connection refused, DNS, or TLS error). Is the indexer running?`;
        reject(endpointRefusalFromWsError(indexerWS, error) ?? new NetworkError(`WebSocket connection failed: ${reason}`, { cause: error }));
      }
    });

    ws.on('close', () => {
      if (!settled) {
        settled = true;
        settle();
        reject(new NetworkError(
          `The indexer at ${indexerWS} closed the connection before the balance was read.\n` +
          'Check that it is running and that the URL is right (--indexer-ws, or: midnight config set indexer-ws <url>), then retry.'
        ));
      }
    });

    timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        ws.close();
        reject(new SyncTimeoutError(
          `The indexer at ${indexerWS} did not finish sending the balance within ${BALANCE_CHECK_TIMEOUT_MS / 1000} s.\n` +
          'It accepted the connection but stopped answering: check that it is healthy and caught up with the node, then retry.'
        ));
      }
    }, BALANCE_CHECK_TIMEOUT_MS);
  });
}

/**
 * Check whether a token type is the native NIGHT token.
 */
export function isNativeToken(tokenType: string): boolean {
  return tokenType === NATIVE_TOKEN_TYPE;
}
