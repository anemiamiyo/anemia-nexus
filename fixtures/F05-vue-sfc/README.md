# F05 vue-sfc

Phase 02 golden fixture for Vue 3 SFC semantics. It is intentionally small
(≤350 lines) and covers:

- `defineProps` with an interface, `withDefaults`, optional/defaulted props;
- `defineEmits` with a type literal;
- `defineSlots` with slot params and a `never` slot (heuristic downgrade);
- component tags, event/directive/attribute bindings, interpolation, slot content;
- dynamic arguments (`v-bind:[key]`) and member expressions (`formatter.save`);
- `<script>` + `<script setup>` in one SFC;
- unresolved prop types (`any`, `never`) for `propsCoverage`.

`expected/` holds the reviewed golden sets:
`symbols.json` (top-level script user symbols, excluding component/member
synthesis), `template-edges.json` (source positions + kind + target name), and
`components.json` (Props/Emits/Slots and propsCoverage).

The golden was reviewed against `vue-tsc --noEmit` and the template AST; it is
not generated from this tool's own output.
