# Stored raw data queries

The authenticated private Site MCP and the built-in Agent share the same validated query engine. No DeepSeek key is needed for MCP: the calling chat supplies its own model. Existing owner access, immutable shard validation and private storage apply to all tools.

1. Call `read_data_catalog` or `discover_raw_data` with no dataset to discover available dataset names and limits.
2. Discover a real match ID with `query_dashboard_data` / `matches`.
3. Call `discover_raw_data` with `match_id`, `raw_dataset`, and a round for dense frame/aim datasets. Field discovery explicitly reports the first 128-row sample and whether it is complete.
4. Call `query_raw_data` with exact columns and scalar AND predicates. Pin `source_revision` while paging. Follow the actual `next_offset`; zero rows never prove the original Demo contained no event.
5. Use `read_raw_data_batch` for up to six independent queries. For global analysis use typed server statistics before selecting a small set of original rows.

Example arguments after discovering the actual ID and fields:

```json
{
  "match_id": "<actual 24-character match ID>",
  "raw_dataset": "owner_events",
  "round_number": 4,
  "columns": ["tick", "type", "damage"],
  "filters": [{"field":"damage","op":"gt","value":0}],
  "offset": 0,
  "limit": 25,
  "source_revision": "<actual source commit>"
}
```

Datasets include owner/player rounds and events, decoded replay actor frames, kills, shots, damage, observed impacts, grenades, utility effects, C4 events/carrier frames, and aim points/camera/target points. Only fields already parsed and stored are available. These are not the original `.dem` bitstream, all engine entities, visibility, audio or input telemetry. No feature may invent missing observations.

Each row carries `record`, `round_number`, an original JSON `locator.path`, `decoded_path` for compressed arrays when applicable, and an evidence reference. Result provenance includes the immutable detail content SHA, source revision and analysis version. Missing fields are listed separately from explicit JSON null. Tuple field names are retained when known and use numerical positions otherwise.

Bounds: 32 columns, 12 predicates (`eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in`, `exists`), 100 displayed rows, 32 KiB response, 30-second frame window, six queries per MCP batch. A large record requires narrower projection. Pagination bounds transport, not an aggregate computation's input cohort. No SQL, code, filesystem or arbitrary network operation is available.
