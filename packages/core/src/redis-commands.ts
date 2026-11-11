/**
 * The Redis commands the console completes: name, argument syntax, a one-line summary and where the keys are.
 * What a command does to the server (read, write, admin) is not here: that is `redisCommandAction` in `sql.ts`,
 * which gates agents, and the completion asks it rather than keeping a second list.
 */

/**
 * Where a command's keys are, counted over the arguments after the (possibly two-word) name, from 0.
 * - `range`: the arguments `first`, `first + step`, … up to `last` (`-1`: to the end) are keys.
 * - `numkeys`: argument `at` says how many keys follow it (EVAL, ZUNIONSTORE, LMPOP…), and `extra` keys
 *   come before it (ZUNIONSTORE's destination).
 * - `after`: every argument after this keyword is a key (XREAD … STREAMS key …, which ends with ids).
 */
export type RedisKeySpec =
  | { range: { first: number; last: number; step: number } }
  | { numkeys: { at: number; extra?: number } }
  | { after: string };

export interface RedisCommandSpec {
  /** Upper case; two words for a subcommand (`CLIENT LIST`). */
  name: string;
  /** The arguments in the syntax of the Redis docs, `[]` optional, `...` repeated. */
  args: string;
  summary: string;
  group: string;
  keys?: RedisKeySpec;
}

const one: RedisKeySpec = { range: { first: 0, last: 0, step: 1 } };
const two: RedisKeySpec = { range: { first: 0, last: 1, step: 1 } };
const all: RedisKeySpec = { range: { first: 0, last: -1, step: 1 } };
const pairs: RedisKeySpec = { range: { first: 0, last: -1, step: 2 } };
const numkeys = (at: number, extra = 0): RedisKeySpec => ({ numkeys: { at, extra } });

type Row = [name: string, args: string, summary: string, keys?: RedisKeySpec];

const GROUPS: Record<string, Row[]> = {
  string: [
    ['GET', 'key', 'Get the value of a key.', one],
    ['SET', 'key value [NX | XX] [GET] [EX seconds | PX milliseconds | EXAT unix-time | PXAT unix-time-ms | KEEPTTL]', 'Set the string value of a key.', one],
    ['SETNX', 'key value', 'Set a key only when it does not exist.', one],
    ['SETEX', 'key seconds value', 'Set a key with an expiry in seconds.', one],
    ['PSETEX', 'key milliseconds value', 'Set a key with an expiry in milliseconds.', one],
    ['GETSET', 'key value', 'Set a key and return its old value.', one],
    ['GETDEL', 'key', 'Get a key and delete it.', one],
    ['GETEX', 'key [EX seconds | PX milliseconds | EXAT unix-time | PXAT unix-time-ms | PERSIST]', 'Get a key and set or remove its expiry.', one],
    ['MGET', 'key [key ...]', 'Get the values of several keys.', all],
    ['MSET', 'key value [key value ...]', 'Set several keys.', pairs],
    ['MSETNX', 'key value [key value ...]', 'Set several keys only when none exists.', pairs],
    ['APPEND', 'key value', 'Append to a string.', one],
    ['STRLEN', 'key', 'Length of a string value.', one],
    ['GETRANGE', 'key start end', 'Substring of a string value.', one],
    ['SETRANGE', 'key offset value', 'Overwrite part of a string from an offset.', one],
    ['INCR', 'key', 'Increment an integer by one.', one],
    ['INCRBY', 'key increment', 'Increment an integer.', one],
    ['INCRBYFLOAT', 'key increment', 'Increment a float.', one],
    ['DECR', 'key', 'Decrement an integer by one.', one],
    ['DECRBY', 'key decrement', 'Decrement an integer.', one],
    ['LCS', 'key1 key2 [LEN] [IDX] [MINMATCHLEN min-match-len] [WITHMATCHLEN]', 'Longest common substring of two strings.', two],
  ],
  bitmap: [
    ['GETBIT', 'key offset', 'Get a bit.', one],
    ['SETBIT', 'key offset value', 'Set or clear a bit.', one],
    ['BITCOUNT', 'key [start end [BYTE | BIT]]', 'Count the set bits.', one],
    ['BITPOS', 'key bit [start [end [BYTE | BIT]]]', 'First bit set or clear.', one],
    ['BITOP', 'AND | OR | XOR | NOT destkey key [key ...]', 'Bitwise operation between strings.', { range: { first: 1, last: -1, step: 1 } }],
    ['BITFIELD', 'key [GET encoding offset | SET encoding offset value | INCRBY encoding offset increment | OVERFLOW WRAP | SAT | FAIL ...]', 'Integer fields of a bitmap.', one],
  ],
  hash: [
    ['HGET', 'key field', 'Get a field of a hash.', one],
    ['HSET', 'key field value [field value ...]', 'Set fields of a hash.', one],
    ['HSETNX', 'key field value', 'Set a field only when it does not exist.', one],
    ['HMGET', 'key field [field ...]', 'Get several fields of a hash.', one],
    ['HMSET', 'key field value [field value ...]', 'Set several fields of a hash (deprecated: HSET).', one],
    ['HGETALL', 'key', 'Every field and value of a hash.', one],
    ['HKEYS', 'key', 'Every field of a hash.', one],
    ['HVALS', 'key', 'Every value of a hash.', one],
    ['HLEN', 'key', 'Number of fields in a hash.', one],
    ['HEXISTS', 'key field', 'Whether a field exists.', one],
    ['HDEL', 'key field [field ...]', 'Delete fields of a hash.', one],
    ['HINCRBY', 'key field increment', 'Increment an integer field.', one],
    ['HINCRBYFLOAT', 'key field increment', 'Increment a float field.', one],
    ['HSTRLEN', 'key field', 'Length of a field value.', one],
    ['HRANDFIELD', 'key [count [WITHVALUES]]', 'Random fields of a hash.', one],
    ['HSCAN', 'key cursor [MATCH pattern] [COUNT count] [NOVALUES]', 'Iterate the fields of a hash.', one],
    ['HEXPIRE', 'key seconds [NX | XX | GT | LT] FIELDS numfields field [field ...]', 'Set an expiry on hash fields.', one],
    ['HTTL', 'key FIELDS numfields field [field ...]', 'Time to live of hash fields.', one],
    ['HPERSIST', 'key FIELDS numfields field [field ...]', 'Remove the expiry of hash fields.', one],
  ],
  list: [
    ['LPUSH', 'key element [element ...]', 'Prepend elements to a list.', one],
    ['RPUSH', 'key element [element ...]', 'Append elements to a list.', one],
    ['LPUSHX', 'key element [element ...]', 'Prepend only when the list exists.', one],
    ['RPUSHX', 'key element [element ...]', 'Append only when the list exists.', one],
    ['LPOP', 'key [count]', 'Remove and return the first elements.', one],
    ['RPOP', 'key [count]', 'Remove and return the last elements.', one],
    ['LRANGE', 'key start stop', 'A range of elements.', one],
    ['LLEN', 'key', 'Length of a list.', one],
    ['LINDEX', 'key index', 'An element by its index.', one],
    ['LSET', 'key index element', 'Set an element by its index.', one],
    ['LINSERT', 'key BEFORE | AFTER pivot element', 'Insert before or after an element.', one],
    ['LREM', 'key count element', 'Remove matching elements.', one],
    ['LTRIM', 'key start stop', 'Trim a list to a range.', one],
    ['LPOS', 'key element [RANK rank] [COUNT num-matches] [MAXLEN len]', 'Index of matching elements.', one],
    ['LMOVE', 'source destination LEFT | RIGHT LEFT | RIGHT', 'Move an element between lists.', two],
    ['RPOPLPUSH', 'source destination', 'Move the last element to another list (deprecated: LMOVE).', two],
    ['LMPOP', 'numkeys key [key ...] LEFT | RIGHT [COUNT count]', 'Pop from the first non-empty list.', numkeys(0)],
    ['BLPOP', 'key [key ...] timeout', 'Pop the first element, blocking.', all],
    ['BRPOP', 'key [key ...] timeout', 'Pop the last element, blocking.', all],
    ['BLMOVE', 'source destination LEFT | RIGHT LEFT | RIGHT timeout', 'Move an element between lists, blocking.', two],
    ['BLMPOP', 'timeout numkeys key [key ...] LEFT | RIGHT [COUNT count]', 'Pop from the first non-empty list, blocking.', numkeys(1)],
  ],
  set: [
    ['SADD', 'key member [member ...]', 'Add members to a set.', one],
    ['SREM', 'key member [member ...]', 'Remove members from a set.', one],
    ['SMEMBERS', 'key', 'Every member of a set.', one],
    ['SISMEMBER', 'key member', 'Whether a member is in a set.', one],
    ['SMISMEMBER', 'key member [member ...]', 'Whether each member is in a set.', one],
    ['SCARD', 'key', 'Number of members in a set.', one],
    ['SPOP', 'key [count]', 'Remove and return random members.', one],
    ['SRANDMEMBER', 'key [count]', 'Random members of a set.', one],
    ['SMOVE', 'source destination member', 'Move a member between sets.', two],
    ['SINTER', 'key [key ...]', 'Intersection of sets.', all],
    ['SINTERCARD', 'numkeys key [key ...] [LIMIT limit]', 'Size of the intersection of sets.', numkeys(0)],
    ['SINTERSTORE', 'destination key [key ...]', 'Store the intersection of sets.', all],
    ['SUNION', 'key [key ...]', 'Union of sets.', all],
    ['SUNIONSTORE', 'destination key [key ...]', 'Store the union of sets.', all],
    ['SDIFF', 'key [key ...]', 'Difference of sets.', all],
    ['SDIFFSTORE', 'destination key [key ...]', 'Store the difference of sets.', all],
    ['SSCAN', 'key cursor [MATCH pattern] [COUNT count]', 'Iterate the members of a set.', one],
  ],
  'sorted set': [
    ['ZADD', 'key [NX | XX] [GT | LT] [CH] [INCR] score member [score member ...]', 'Add members with scores.', one],
    ['ZREM', 'key member [member ...]', 'Remove members.', one],
    ['ZSCORE', 'key member', 'Score of a member.', one],
    ['ZMSCORE', 'key member [member ...]', 'Scores of several members.', one],
    ['ZINCRBY', 'key increment member', 'Increment the score of a member.', one],
    ['ZCARD', 'key', 'Number of members.', one],
    ['ZCOUNT', 'key min max', 'Members within a score range.', one],
    ['ZLEXCOUNT', 'key min max', 'Members within a lexicographical range.', one],
    ['ZRANGE', 'key start stop [BYSCORE | BYLEX] [REV] [LIMIT offset count] [WITHSCORES]', 'A range of members.', one],
    ['ZRANGESTORE', 'dst src min max [BYSCORE | BYLEX] [REV] [LIMIT offset count]', 'Store a range of members.', two],
    ['ZREVRANGE', 'key start stop [WITHSCORES]', 'A range by index, high to low.', one],
    ['ZRANGEBYSCORE', 'key min max [WITHSCORES] [LIMIT offset count]', 'Members by score.', one],
    ['ZREVRANGEBYSCORE', 'key max min [WITHSCORES] [LIMIT offset count]', 'Members by score, high to low.', one],
    ['ZRANGEBYLEX', 'key min max [LIMIT offset count]', 'Members by lexicographical range.', one],
    ['ZRANK', 'key member [WITHSCORE]', 'Rank of a member, low to high.', one],
    ['ZREVRANK', 'key member [WITHSCORE]', 'Rank of a member, high to low.', one],
    ['ZREMRANGEBYRANK', 'key start stop', 'Remove members by rank.', one],
    ['ZREMRANGEBYSCORE', 'key min max', 'Remove members by score.', one],
    ['ZREMRANGEBYLEX', 'key min max', 'Remove members by lexicographical range.', one],
    ['ZPOPMIN', 'key [count]', 'Remove and return the lowest members.', one],
    ['ZPOPMAX', 'key [count]', 'Remove and return the highest members.', one],
    ['ZRANDMEMBER', 'key [count [WITHSCORES]]', 'Random members.', one],
    ['ZSCAN', 'key cursor [MATCH pattern] [COUNT count]', 'Iterate members and scores.', one],
    ['ZUNION', 'numkeys key [key ...] [WEIGHTS weight [weight ...]] [AGGREGATE SUM | MIN | MAX] [WITHSCORES]', 'Union of sorted sets.', numkeys(0)],
    ['ZUNIONSTORE', 'destination numkeys key [key ...] [WEIGHTS weight [weight ...]] [AGGREGATE SUM | MIN | MAX]', 'Store the union of sorted sets.', numkeys(1, 1)],
    ['ZINTER', 'numkeys key [key ...] [WEIGHTS weight [weight ...]] [AGGREGATE SUM | MIN | MAX] [WITHSCORES]', 'Intersection of sorted sets.', numkeys(0)],
    ['ZINTERSTORE', 'destination numkeys key [key ...] [WEIGHTS weight [weight ...]] [AGGREGATE SUM | MIN | MAX]', 'Store the intersection of sorted sets.', numkeys(1, 1)],
    ['ZINTERCARD', 'numkeys key [key ...] [LIMIT limit]', 'Size of the intersection of sorted sets.', numkeys(0)],
    ['ZDIFF', 'numkeys key [key ...] [WITHSCORES]', 'Difference of sorted sets.', numkeys(0)],
    ['ZDIFFSTORE', 'destination numkeys key [key ...]', 'Store the difference of sorted sets.', numkeys(1, 1)],
    ['ZMPOP', 'numkeys key [key ...] MIN | MAX [COUNT count]', 'Pop from the first non-empty sorted set.', numkeys(0)],
    ['BZPOPMIN', 'key [key ...] timeout', 'Pop the lowest member, blocking.', all],
    ['BZPOPMAX', 'key [key ...] timeout', 'Pop the highest member, blocking.', all],
  ],
  stream: [
    ['XADD', 'key [NOMKSTREAM] [MAXLEN | MINID [= | ~] threshold [LIMIT count]] * | id field value [field value ...]', 'Append an entry to a stream.', one],
    ['XLEN', 'key', 'Number of entries in a stream.', one],
    ['XRANGE', 'key start end [COUNT count]', 'Entries in an id range.', one],
    ['XREVRANGE', 'key end start [COUNT count]', 'Entries in an id range, newest first.', one],
    ['XREAD', '[COUNT count] [BLOCK milliseconds] STREAMS key [key ...] id [id ...]', 'Read entries from streams.', { after: 'STREAMS' }],
    ['XREADGROUP', 'GROUP group consumer [COUNT count] [BLOCK milliseconds] [NOACK] STREAMS key [key ...] id [id ...]', 'Read entries as a consumer group.', { after: 'STREAMS' }],
    ['XDEL', 'key id [id ...]', 'Delete entries.', one],
    ['XTRIM', 'key MAXLEN | MINID [= | ~] threshold [LIMIT count]', 'Trim a stream.', one],
    ['XACK', 'key group id [id ...]', 'Acknowledge entries of a group.', one],
    ['XPENDING', 'key group [[IDLE min-idle-time] start end count [consumer]]', 'Pending entries of a group.', one],
    ['XCLAIM', 'key group consumer min-idle-time id [id ...] [IDLE ms] [TIME unix-time-milliseconds] [RETRYCOUNT count] [FORCE] [JUSTID] [LASTID lastid]', 'Change the owner of pending entries.', one],
    ['XAUTOCLAIM', 'key group consumer min-idle-time start [COUNT count] [JUSTID]', 'Claim idle pending entries.', one],
    ['XGROUP CREATE', 'key group id | $ [MKSTREAM] [ENTRIESREAD entries-read]', 'Create a consumer group.', one],
    ['XGROUP DESTROY', 'key group', 'Delete a consumer group.', one],
    ['XGROUP CREATECONSUMER', 'key group consumer', 'Create a consumer in a group.', one],
    ['XGROUP DELCONSUMER', 'key group consumer', 'Delete a consumer from a group.', one],
    ['XGROUP SETID', 'key group id | $ [ENTRIESREAD entries-read]', 'Set the last delivered id of a group.', one],
    ['XINFO STREAM', 'key [FULL [COUNT count]]', 'About a stream.', one],
    ['XINFO GROUPS', 'key', 'The consumer groups of a stream.', one],
    ['XINFO CONSUMERS', 'key group', 'The consumers of a group.', one],
  ],
  keys: [
    ['DEL', 'key [key ...]', 'Delete keys.', all],
    ['UNLINK', 'key [key ...]', 'Delete keys, freeing memory in the background.', all],
    ['EXISTS', 'key [key ...]', 'How many of the keys exist.', all],
    ['TYPE', 'key', 'Type of the value at a key.', one],
    ['TTL', 'key', 'Time to live in seconds.', one],
    ['PTTL', 'key', 'Time to live in milliseconds.', one],
    ['EXPIRETIME', 'key', 'Expiry as a Unix time in seconds.', one],
    ['EXPIRE', 'key seconds [NX | XX | GT | LT]', 'Set an expiry in seconds.', one],
    ['PEXPIRE', 'key milliseconds [NX | XX | GT | LT]', 'Set an expiry in milliseconds.', one],
    ['EXPIREAT', 'key unix-time-seconds [NX | XX | GT | LT]', 'Set an expiry at a Unix time.', one],
    ['PEXPIREAT', 'key unix-time-milliseconds [NX | XX | GT | LT]', 'Set an expiry at a Unix time in milliseconds.', one],
    ['PERSIST', 'key', 'Remove the expiry.', one],
    ['RENAME', 'key newkey', 'Rename a key.', two],
    ['RENAMENX', 'key newkey', 'Rename a key when the new name is free.', two],
    ['COPY', 'source destination [DB destination-db] [REPLACE]', 'Copy a key.', two],
    ['MOVE', 'key db', 'Move a key to another database.', one],
    ['DUMP', 'key', 'Serialized value of a key.', one],
    ['RESTORE', 'key ttl serialized-value [REPLACE] [ABSTTL] [IDLETIME seconds] [FREQ frequency]', 'Create a key from DUMP output.', one],
    ['TOUCH', 'key [key ...]', 'Update the last access time of keys.', all],
    ['OBJECT ENCODING', 'key', 'Internal encoding of a value.', one],
    ['OBJECT FREQ', 'key', 'Access frequency of a key (LFU).', one],
    ['OBJECT IDLETIME', 'key', 'Seconds since the key was last accessed.', one],
    ['OBJECT REFCOUNT', 'key', 'Reference count of a value.', one],
    ['SCAN', 'cursor [MATCH pattern] [COUNT count] [TYPE type]', 'Iterate the keys.'],
    ['KEYS', 'pattern', 'Every key matching a pattern (blocks the server: prefer SCAN).'],
    ['RANDOMKEY', '', 'A random key.'],
    ['SORT', 'key [BY pattern] [LIMIT offset count] [GET pattern [GET pattern ...]] [ASC | DESC] [ALPHA] [STORE destination]', 'Sort a list, set or sorted set.', one],
    ['SORT_RO', 'key [BY pattern] [LIMIT offset count] [GET pattern [GET pattern ...]] [ASC | DESC] [ALPHA]', 'Sort, read only.', one],
    ['WAIT', 'numreplicas timeout', 'Wait for replicas to acknowledge writes.'],
  ],
  geo: [
    ['GEOADD', 'key [NX | XX] [CH] longitude latitude member [longitude latitude member ...]', 'Add places.', one],
    ['GEOPOS', 'key [member [member ...]]', 'Longitude and latitude of members.', one],
    ['GEODIST', 'key member1 member2 [M | KM | FT | MI]', 'Distance between two members.', one],
    ['GEOHASH', 'key [member [member ...]]', 'Geohash strings of members.', one],
    ['GEOSEARCH', 'key FROMMEMBER member | FROMLONLAT longitude latitude BYRADIUS radius M | KM | FT | MI | BYBOX width height M | KM | FT | MI [ASC | DESC] [COUNT count [ANY]] [WITHCOORD] [WITHDIST] [WITHHASH]', 'Members within an area.', one],
    ['GEORADIUS_RO', 'key longitude latitude radius M | KM | FT | MI [WITHCOORD] [WITHDIST] [WITHHASH] [COUNT count [ANY]] [ASC | DESC]', 'Members within a radius (deprecated: GEOSEARCH).', one],
    ['GEORADIUSBYMEMBER_RO', 'key member radius M | KM | FT | MI [WITHCOORD] [WITHDIST] [WITHHASH] [COUNT count [ANY]] [ASC | DESC]', 'Members within a radius of a member (deprecated: GEOSEARCH).', one],
    ['GEOSEARCHSTORE', 'destination source FROMMEMBER member | FROMLONLAT longitude latitude BYRADIUS radius M | KM | FT | MI | BYBOX width height M | KM | FT | MI [ASC | DESC] [COUNT count [ANY]] [STOREDIST]', 'Store the members within an area.', two],
  ],
  hyperloglog: [
    ['PFADD', 'key [element [element ...]]', 'Add elements to a HyperLogLog.', one],
    ['PFCOUNT', 'key [key ...]', 'Approximate cardinality.', all],
    ['PFMERGE', 'destkey [sourcekey [sourcekey ...]]', 'Merge HyperLogLogs.', all],
  ],
  pubsub: [
    ['PUBLISH', 'channel message', 'Post a message to a channel.'],
    ['SUBSCRIBE', 'channel [channel ...]', 'Listen to channels.'],
    ['PSUBSCRIBE', 'pattern [pattern ...]', 'Listen to channels matching patterns.'],
    ['UNSUBSCRIBE', '[channel [channel ...]]', 'Stop listening to channels.'],
    ['PUBSUB CHANNELS', '[pattern]', 'Active channels.'],
    ['PUBSUB NUMSUB', '[channel [channel ...]]', 'Subscribers per channel.'],
    ['PUBSUB NUMPAT', '', 'Number of pattern subscriptions.'],
  ],
  scripting: [
    ['EVAL', 'script numkeys [key [key ...]] [arg [arg ...]]', 'Run a Lua script.', numkeys(1)],
    ['EVALSHA', 'sha1 numkeys [key [key ...]] [arg [arg ...]]', 'Run a cached Lua script.', numkeys(1)],
    ['EVAL_RO', 'script numkeys [key [key ...]] [arg [arg ...]]', 'Run a read-only Lua script.', numkeys(1)],
    ['EVALSHA_RO', 'sha1 numkeys [key [key ...]] [arg [arg ...]]', 'Run a cached read-only Lua script.', numkeys(1)],
    ['FCALL', 'function numkeys [key [key ...]] [arg [arg ...]]', 'Call a function.', numkeys(1)],
    ['FCALL_RO', 'function numkeys [key [key ...]] [arg [arg ...]]', 'Call a read-only function.', numkeys(1)],
    ['SCRIPT LOAD', 'script', 'Cache a Lua script.'],
    ['SCRIPT EXISTS', 'sha1 [sha1 ...]', 'Whether scripts are cached.'],
    ['SCRIPT FLUSH', '[ASYNC | SYNC]', 'Empty the script cache.'],
    ['FUNCTION LIST', '[LIBRARYNAME library-name-pattern] [WITHCODE]', 'Loaded function libraries.'],
    ['FUNCTION LOAD', '[REPLACE] function-code', 'Load a function library.'],
    ['FUNCTION DELETE', 'library-name', 'Delete a function library.'],
  ],
  transactions: [
    ['MULTI', '', 'Start a transaction.'],
    ['EXEC', '', 'Run the queued commands of a transaction.'],
    ['DISCARD', '', 'Drop the queued commands of a transaction.'],
    ['WATCH', 'key [key ...]', 'Watch keys for a transaction.', all],
    ['UNWATCH', '', 'Forget the watched keys.'],
  ],
  connection: [
    ['PING', '[message]', 'Check the connection.'],
    ['ECHO', 'message', 'Return the message.'],
    ['SELECT', 'index', 'Change the database of the connection.'],
    ['AUTH', '[username] password', 'Authenticate the connection.'],
    ['HELLO', '[protover [AUTH username password] [SETNAME clientname]]', 'Handshake and switch protocol.'],
    ['RESET', '', 'Reset the connection.'],
    ['CLIENT LIST', '[TYPE NORMAL | MASTER | REPLICA | PUBSUB] [ID client-id [client-id ...]]', 'Connected clients.'],
    ['CLIENT INFO', '', 'This connection.'],
    ['CLIENT ID', '', 'Id of this connection.'],
    ['CLIENT GETNAME', '', 'Name of this connection.'],
    ['CLIENT SETNAME', 'connection-name', 'Name this connection.'],
    ['CLIENT KILL', '[ID client-id] [TYPE NORMAL | MASTER | SLAVE | REPLICA | PUBSUB] [USER username] [ADDR ip:port] [LADDR ip:port] [SKIPME YES | NO] [MAXAGE maxage]', 'Close client connections.'],
    ['CLIENT PAUSE', 'timeout [WRITE | ALL]', 'Suspend clients.'],
    ['CLIENT UNPAUSE', '', 'Resume paused clients.'],
    ['CLIENT UNBLOCK', 'client-id [TIMEOUT | ERROR]', 'Unblock a client in a blocking command.'],
    ['CLIENT NO-EVICT', 'ON | OFF', 'Whether this client may be evicted.'],
    ['CLIENT TRACKINGINFO', '', 'Client-side caching of this connection.'],
  ],
  server: [
    ['INFO', '[section [section ...]]', 'Server information and statistics.'],
    ['DBSIZE', '', 'Number of keys in the database.'],
    ['TIME', '', 'Server time.'],
    ['LASTSAVE', '', 'Unix time of the last save to disk.'],
    ['FLUSHDB', '[ASYNC | SYNC]', 'Delete every key of the database.'],
    ['FLUSHALL', '[ASYNC | SYNC]', 'Delete every key of every database.'],
    ['SAVE', '', 'Save the dataset to disk, blocking.'],
    ['BGSAVE', '[SCHEDULE]', 'Save the dataset to disk in the background.'],
    ['BGREWRITEAOF', '', 'Rewrite the append-only file in the background.'],
    ['SHUTDOWN', '[NOSAVE | SAVE] [NOW] [FORCE] [ABORT]', 'Stop the server.'],
    ['SWAPDB', 'index1 index2', 'Swap two databases.'],
    ['MONITOR', '', 'Stream every command the server runs.'],
    ['ROLE', '', 'Replication role.'],
    ['REPLICAOF', 'host port | NO ONE', 'Make the server a replica, or stop.'],
    ['CONFIG GET', 'parameter [parameter ...]', 'Configuration parameters.'],
    ['CONFIG SET', 'parameter value [parameter value ...]', 'Change configuration parameters.'],
    ['CONFIG RESETSTAT', '', 'Reset the statistics of INFO.'],
    ['CONFIG REWRITE', '', 'Write the configuration to the config file.'],
    ['MEMORY USAGE', 'key [SAMPLES count]', 'Bytes a key takes.', one],
    ['MEMORY STATS', '', 'Memory usage details.'],
    ['MEMORY DOCTOR', '', 'Memory problems and advice.'],
    ['MEMORY PURGE', '', 'Ask the allocator to release memory.'],
    ['SLOWLOG GET', '[count]', 'Entries of the slow log.'],
    ['SLOWLOG LEN', '', 'Length of the slow log.'],
    ['SLOWLOG RESET', '', 'Empty the slow log.'],
    ['LATENCY LATEST', '', 'Latest latency samples.'],
    ['LATENCY DOCTOR', '', 'Latency analysis.'],
    ['COMMAND COUNT', '', 'Number of commands.'],
    ['COMMAND INFO', '[command-name [command-name ...]]', 'About commands.'],
    ['COMMAND DOCS', '[command-name [command-name ...]]', 'Documentation of commands.'],
    ['ACL WHOAMI', '', 'User of this connection.'],
    ['ACL LIST', '', 'ACL rules.'],
    ['ACL USERS', '', 'ACL user names.'],
    ['ACL GETUSER', 'username', 'Rules of a user.'],
    ['ACL SETUSER', 'username [rule [rule ...]]', 'Create or change a user.'],
    ['ACL DELUSER', 'username [username ...]', 'Delete users.'],
    ['ACL CAT', '[category]', 'Command categories.'],
    ['ACL LOG', '[count | RESET]', 'Denied commands and logins.'],
    ['MODULE LIST', '', 'Loaded modules.'],
    ['CLUSTER INFO', '', 'State of the cluster.'],
    ['CLUSTER NODES', '', 'Nodes of the cluster.'],
    ['CLUSTER SHARDS', '', 'Shards of the cluster.'],
    ['CLUSTER KEYSLOT', 'key', 'Hash slot of a key.'],
    ['DEBUG OBJECT', 'key', 'Debugging details of a key.', one],
    ['LOLWUT', '[VERSION version]', 'Computer art and the Redis version.'],
  ],
  json: [
    ['JSON.GET', 'key [INDENT indent] [NEWLINE newline] [SPACE space] [path [path ...]]', 'JSON at paths.', one],
    ['JSON.SET', 'key path value [NX | XX]', 'Set JSON at a path.', one],
    ['JSON.MGET', 'key [key ...] path', 'JSON at a path of several keys.', all],
    ['JSON.DEL', 'key [path]', 'Delete JSON at a path.', one],
    ['JSON.TYPE', 'key [path]', 'Type of the JSON at a path.', one],
    ['JSON.STRLEN', 'key [path]', 'Length of a JSON string.', one],
    ['JSON.ARRLEN', 'key [path]', 'Length of a JSON array.', one],
    ['JSON.ARRAPPEND', 'key path value [value ...]', 'Append to a JSON array.', one],
    ['JSON.OBJKEYS', 'key [path]', 'Keys of a JSON object.', one],
    ['JSON.OBJLEN', 'key [path]', 'Number of keys of a JSON object.', one],
    ['JSON.NUMINCRBY', 'key path value', 'Increment a JSON number.', one],
  ],
  search: [
    ['FT._LIST', '', 'Search indexes.'],
    ['FT.INFO', 'index', 'About a search index.'],
    ['FT.SEARCH', 'index query [NOCONTENT] [VERBATIM] [RETURN count identifier [identifier ...]] [SORTBY sortby [ASC | DESC]] [LIMIT offset num] [PARAMS nargs name value [name value ...]] [DIALECT dialect]', 'Search an index.'],
  ],
  timeseries: [
    ['TS.GET', 'key', 'Latest sample of a time series.', one],
    ['TS.RANGE', 'key fromTimestamp toTimestamp [COUNT count] [AGGREGATION aggregator bucketDuration]', 'Samples in a time range.', one],
    ['TS.INFO', 'key [DEBUG]', 'About a time series.', one],
    ['TS.ADD', 'key timestamp value [RETENTION retentionPeriod] [LABELS label value ...]', 'Append a sample.', one],
  ],
};

/** Every command the console completes, sorted by name. */
export const REDIS_COMMANDS: readonly RedisCommandSpec[] = Object.entries(GROUPS)
  .flatMap(([group, rows]) => rows.map(([name, args, summary, keys]): RedisCommandSpec => ({ name, args, summary, group, ...(keys ? { keys } : {}) })))
  .sort((a, b) => a.name.localeCompare(b.name));

const BY_NAME = new Map(REDIS_COMMANDS.map((c) => [c.name, c]));

/** The first words of two-word commands (CLIENT, CONFIG, XINFO…), which take a subcommand. */
export const REDIS_CONTAINER_COMMANDS: ReadonlySet<string> = new Set(REDIS_COMMANDS.filter((c) => c.name.includes(' ')).map((c) => c.name.split(' ')[0]!));

/** The command named by the first words of a line, two words for a subcommand, case-insensitive. */
export function findRedisCommand(words: readonly string[]): { spec: RedisCommandSpec; words: number } | null {
  const first = (words[0] ?? '').toUpperCase();
  if (!first) return null;
  if (words.length > 1 && REDIS_CONTAINER_COMMANDS.has(first)) {
    const spec = BY_NAME.get(`${first} ${words[1]!.toUpperCase()}`);
    if (spec) return { spec, words: 2 };
  }
  const spec = BY_NAME.get(first);
  return spec ? { spec, words: 1 } : null;
}

/** The subcommands of a container command (`CLIENT` → CLIENT LIST, CLIENT KILL…). */
export function redisSubcommands(container: string): RedisCommandSpec[] {
  const head = `${container.toUpperCase()} `;
  return REDIS_COMMANDS.filter((c) => c.name.startsWith(head));
}

/** `GET key`: the name with its argument syntax, for a signature hint. */
export function redisSignature(spec: RedisCommandSpec): string {
  return spec.args ? `${spec.name} ${spec.args}` : spec.name;
}
