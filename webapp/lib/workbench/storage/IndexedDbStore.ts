/*
 * Exports:
 * - IndexedDbObjectStoreDefinition: declarative object-store schema entry for browser persistence. Keywords: IndexedDB, schema, object store.
 * - IndexedDbStoreOptions: database configuration for the shared IndexedDB controller. Keywords: IndexedDB, database, upgrade.
 * - default IndexedDbStore: shared IndexedDB open, upgrade, transaction, read, write, and delete controller. Keywords: IndexedDB, storage, persistence.
 */

export interface IndexedDbObjectStoreDefinition<TStoreName extends string = string> {
  deleteBeforeVersion?: number;
  name: TStoreName;
  options?: IDBObjectStoreParameters;
}

export interface IndexedDbStoreOptions<TStoreName extends string = string> {
  databaseName: string;
  stores: readonly IndexedDbObjectStoreDefinition<TStoreName>[];
  version: number;
}

function wrapIndexedDbRequest<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("IndexedDB request failed."));
    };
  });
}

function waitForTransaction(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onabort = () => {
      reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
    };
    transaction.onerror = () => {
      reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    };
  });
}

export default class IndexedDbStore<TStoreName extends string = string> {
  private readonly databasePromise: Promise<IDBDatabase | null>;
  private writeQueue = Promise.resolve();

  constructor(private readonly options: IndexedDbStoreOptions<TStoreName>) {
    this.databasePromise = this.openDatabase();
  }

  async getAll<TRecord>(storeName: TStoreName) {
    const database = await this.databasePromise;
    if (!database || !this.hasObjectStore(database, storeName)) {
      return [] as TRecord[];
    }

    const transaction = database.transaction(storeName, "readonly");
    const store = transaction.objectStore(storeName);
    const records = await wrapIndexedDbRequest(store.getAll() as IDBRequest<TRecord[]>);
    await waitForTransaction(transaction);
    return records;
  }

  put<TRecord>(storeName: TStoreName, record: TRecord) {
    return this.enqueueWrite(async (database) => {
      if (!this.hasObjectStore(database, storeName)) {
        return;
      }

      const transaction = database.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      await wrapIndexedDbRequest(store.put(record));
      await waitForTransaction(transaction);
    });
  }

  delete(storeName: TStoreName, key: IDBValidKey) {
    return this.enqueueWrite(async (database) => {
      if (!this.hasObjectStore(database, storeName)) {
        return;
      }

      const transaction = database.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      await wrapIndexedDbRequest(store.delete(key));
      await waitForTransaction(transaction);
    });
  }

  enqueueWrite(operation: (database: IDBDatabase) => Promise<void>) {
    this.writeQueue = this.writeQueue
      .catch(() => {
        // Keep later persistence operations flowing after a transient failure.
      })
      .then(async () => {
        const database = await this.databasePromise;
        if (!database) {
          return;
        }

        await operation(database);
      });

    return this.writeQueue;
  }

  private hasObjectStore(database: IDBDatabase, storeName: TStoreName) {
    return database.objectStoreNames.contains(storeName);
  }

  private openDatabase() {
    if (typeof window === "undefined" || typeof window.indexedDB === "undefined") {
      return Promise.resolve<IDBDatabase | null>(null);
    }

    return new Promise<IDBDatabase | null>((resolve) => {
      const request = window.indexedDB.open(this.options.databaseName, this.options.version);

      request.onupgradeneeded = (event) => {
        const database = request.result;
        for (const storeDefinition of this.options.stores) {
          if (
            storeDefinition.deleteBeforeVersion
            && event.oldVersion > 0
            && event.oldVersion < storeDefinition.deleteBeforeVersion
            && database.objectStoreNames.contains(storeDefinition.name)
          ) {
            database.deleteObjectStore(storeDefinition.name);
          }

          if (!database.objectStoreNames.contains(storeDefinition.name)) {
            database.createObjectStore(storeDefinition.name, storeDefinition.options);
          }
        }
      };

      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
        };
        resolve(database);
      };

      request.onerror = () => {
        resolve(null);
      };

      request.onblocked = () => {
        resolve(null);
      };
    });
  }
}
