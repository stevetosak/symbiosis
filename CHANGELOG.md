# Changelog

## [0.2.0](https://github.com/stevetosak/symbiosis/compare/v0.1.0...v0.2.0) (2026-10-20)


### Features

* a reusable demo: a scripted pi in a to-do app, and the same task for a real pi ([3d94bc1](https://github.com/stevetosak/symbiosis/commit/3d94bc11e3a083f40d0b9aad561269051ddd3187))
* ask pi about code, with notes kept per line (slice 3) ([#27](https://github.com/stevetosak/symbiosis/issues/27)) ([a0bd954](https://github.com/stevetosak/symbiosis/commit/a0bd9541d9f77f88b8df25a04f46de67c19a8777))
* bring back the typed preview, behind follow ([#37](https://github.com/stevetosak/symbiosis/issues/37)) ([ee1b644](https://github.com/stevetosak/symbiosis/commit/ee1b64447c609ead09e5cad96852c4d734f5ddd4))
* change list with the plan, changed-line marks, seen and exact diff; drop the replay ([#31](https://github.com/stevetosak/symbiosis/issues/31)) ([ff9aa3a](https://github.com/stevetosak/symbiosis/commit/ff9aa3a51d1b54126e01de57c4e67e7520516ff6))
* chat in the ttt terminal and AI!/AI? suggestions ([05ee306](https://github.com/stevetosak/symbiosis/commit/05ee306687b8b192902eab9dd45a1d5aa3e152b7))
* core stubs, import policies and scope guard (slice 2a) ([#10](https://github.com/stevetosak/symbiosis/issues/10)) ([2819384](https://github.com/stevetosak/symbiosis/commit/2819384cdec37446599e8ab8b2722151d55dca62))
* ctrl+k h panel, settings in place, autosave, session names ([6f8cf6d](https://github.com/stevetosak/symbiosis/commit/6f8cf6d853f18e7c88ad0453b20058af90539117))
* ctrl+k w shows what pi changed in its last turn ([6bb9ca2](https://github.com/stevetosak/symbiosis/commit/6bb9ca274c9189983ab7c3b8f038f5ffdd45626f))
* demo scenarios, one for each feature, with a headless check ([#33](https://github.com/stevetosak/symbiosis/issues/33)) ([0f245b8](https://github.com/stevetosak/symbiosis/commit/0f245b81262fb366bb57a528ca33e0c51ac307bd))
* fill a stub from ttt, guard each edit, propose blocked changes (slice 2b) ([#22](https://github.com/stevetosak/symbiosis/issues/22)) ([19ee1fe](https://github.com/stevetosak/symbiosis/commit/19ee1fe54053844b1812ffc78f95a369320f0bbc))
* helpi! asks the session's model where you write; drop AI!/AI? and ctrl+k d ([ed5125d](https://github.com/stevetosak/symbiosis/commit/ed5125d1d505b10f3a746126621ea256c0620188))
* helpi! fills stubs and writes a function from its description (slice 2c), stubs demo ([#23](https://github.com/stevetosak/symbiosis/issues/23)) ([03b635c](https://github.com/stevetosak/symbiosis/commit/03b635c1afc99165d39a4f2c630eea99666c08c4))
* **helpi:** a waiting line while pi thinks; Enter asks again after undo ([dcf2d60](https://github.com/stevetosak/symbiosis/commit/dcf2d6062512dc9eeb84ee82d6e113cfe7492c0e))
* install without herdr, the symbiosis command, herdr's action runs symbiosis --tab ([#5](https://github.com/stevetosak/symbiosis/issues/5)) ([a28d2bc](https://github.com/stevetosak/symbiosis/commit/a28d2bc03299a51a8fc34ea0a3d104940859a595))
* install.sh, a herdr plugin, and the repo as a pi package that carries the ttt plugin ([c96ffcb](https://github.com/stevetosak/symbiosis/commit/c96ffcbf5184c39f25743df96768947aefbf22be))
* npm run demo opens the demo with the symbiosis command; --real gives a real pi the task ([#6](https://github.com/stevetosak/symbiosis/issues/6)) ([95ccf7b](https://github.com/stevetosak/symbiosis/commit/95ccf7b35aa0c036c6c539e4495747a19727ff7b))
* review each filled body, with a gutter mark until acked (slice 4) ([#28](https://github.com/stevetosak/symbiosis/issues/28)) ([c04d183](https://github.com/stevetosak/symbiosis/commit/c04d1833498f5eedaef77909b06c450bb18614cd))
* session bar; the editor follows one pi session; drop the chat panel ([a9b9ce0](https://github.com/stevetosak/symbiosis/commit/a9b9ce0b4019ddbc29a4041c3709ba2215051674))
* stream pi writes and edits into the ttt editor ([65736ec](https://github.com/stevetosak/symbiosis/commit/65736ecddbb5a0a8b04693906b71a7f021baa052))
* symbiosis close (ctrl+k z), detach from pi, name ttt's tab ([#29](https://github.com/stevetosak/symbiosis/issues/29)) ([3ac9d15](https://github.com/stevetosak/symbiosis/commit/3ac9d15a5be4d246b65f373a16da6f1c516028f5))
* symbiosis opens a real pi beside ttt, in a tab or a split ([d4a803a](https://github.com/stevetosak/symbiosis/commit/d4a803ae265f5023a25171457d7dc950d6ea9663))
* symbiosis opens a real pi beside ttt, in a tab or a split ([2bcb280](https://github.com/stevetosak/symbiosis/commit/2bcb28041a97b3511e8bfb741ddd4c5956f6423a))
* symbiosis version, one version number, release-please ([#38](https://github.com/stevetosak/symbiosis/issues/38)) ([8978149](https://github.com/stevetosak/symbiosis/commit/8978149d874b4b593f8f7ef7149b65913816ec64))
* the editor replays pi's changes behind it; pi waits only past a lag limit ([e9f1cc0](https://github.com/stevetosak/symbiosis/commit/e9f1cc06eb40d7a2c0361719268812bd4bd0b932))
* the file tree follows pi; a "pi files" sidebar panel for every session's files ([087321a](https://github.com/stevetosak/symbiosis/commit/087321afb243693203f90ad72e80eea395e892f4))
* the preview types at a speed you set, and pi waits for it ([ca4b0ee](https://github.com/stevetosak/symbiosis/commit/ca4b0ee1b090617ff33605f17bc86af9db85d53c))
* the symbiosis command, pi in RPC mode behind ttt ([a244a59](https://github.com/stevetosak/symbiosis/commit/a244a59df04a5b7940684b6cf853ccfd61b7f14f))
* the symbiosis command, pi in RPC mode behind ttt; prompts and pi's dialogs in ttt's command line ([01f0e4b](https://github.com/stevetosak/symbiosis/commit/01f0e4bb054665915805df54cffc22d9641f0d42))
* the timeline; pi keeps a plan, the editor shows done › now › next ([e702cc5](https://github.com/stevetosak/symbiosis/commit/e702cc57417166ce225e5f4ca4b450e5f3037458))
* ttt plugin - split into modules and features; e2e scripts run on macOS ([#11](https://github.com/stevetosak/symbiosis/issues/11)) ([3f73f97](https://github.com/stevetosak/symbiosis/commit/3f73f97226d215d8984fb5b4deee7983cfa77232))


### Fixes

* **install:** bind prefix+shift+s to Open symbiosis; herdr has no menu for plugin actions ([e8f1304](https://github.com/stevetosak/symbiosis/commit/e8f1304cc68d328588e85c13e27dfacb42ae23c4))
* **install:** pi writes the package path relative to its settings folder ([c1bfe7d](https://github.com/stevetosak/symbiosis/commit/c1bfe7dc668fe93e9387548a3a6062bfe27f638d))
* the editor follows the session that wrote the file, else the most recent one ([0e3a045](https://github.com/stevetosak/symbiosis/commit/0e3a0454999357253ac16f644550a3cda4829913))
* the plan snippet does not repeat the tool name ([71c74a5](https://github.com/stevetosak/symbiosis/commit/71c74a535daf6334b6cfd0569a4e4ec4eed0dc32))
* the plan tool accepts the arguments models really send ([ddc5ba6](https://github.com/stevetosak/symbiosis/commit/ddc5ba62768ba91ec11ed3730086f6c3842d630a))
* the plan tool's description shows the argument shape ([c55d299](https://github.com/stevetosak/symbiosis/commit/c55d29921452c8b0995f8143bcabb222e0b702da))
