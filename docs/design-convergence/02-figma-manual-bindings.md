# 02. Figma fixture와 manual binding

## 목표

live Figma token 없이 첫 vertical slice의 디자인 입력을 테스트 가능하게 만든다. Figma raw fixture, REST mock, local cache, normalization, candidate selection, manual `design-bindings.json`, source preflight까지 구현한다.

이 phase는 AI-assisted binding을 시작하지 않는다.

## 선행 조건

- [01. 기초 구조, 설정, 계약](./01-foundation-config-contracts.md)이 완료되어야 한다.
- config loader가 fixture path와 artifact path를 project root 안으로 제한해야 한다.
- `@design-convergence/shared`, `@design-convergence/config`, `design-convergence` private CLI가 있어야 한다. `@design-convergence/figma`는 이 phase에서 생성한다.

## 생성/수정 예정 파일

```text
packages/design-convergence-figma/
  src/index.ts
  src/fixture-source.ts
  src/rest-source.ts
  src/cache.ts
  src/normalize.ts
  src/candidates.ts
  test/fixture-source.test.ts
  test/rest-source.test.ts
  test/cache.test.ts
  test/normalize.test.ts
  test/candidates.test.ts

packages/design-convergence-shared/
  src/bindings.ts
  test/bindings.test.ts

fixtures/design-convergence/figma/
  pricing-card.raw.json
  pricing-card.unsupported.raw.json

fixtures/design-convergence/bindings/
  pricing-card.design-bindings.json
  duplicate.design-bindings.json
  stale-source-range.design-bindings.json

apps/design-convergence/src/commands/
  extract-figma.ts
  validate-bindings.ts
```

## 작은 체크박스 작업

### Raw fixture와 REST mock

- [ ] `FigmaNodeSource`를 `fixture`와 `figma-rest` source kind로 나눈다.
- [ ] 기본 테스트는 fixture source만 사용한다.
- [ ] REST source는 fetch 호출을 주입 가능한 함수로 받아 테스트에서 mock한다.
- [ ] `FIGMA_ACCESS_TOKEN` 없이 REST source를 실행하면 `figma-auth` error로 실패한다.
- [ ] REST source는 고정된 Figma API origin, URL-encoded file/node IDs, header token, timeout, response byte/depth/node budget를 사용한다.
- [ ] redirect와 예상하지 않은 content type을 거부하고 auth header/token을 artifact나 log에 쓰지 않는다.
- [ ] 401/403은 `figma-auth`, transport/5xx/429 exhaustion은 `figma-fetch`로 분류하고 bounded `Retry-After`만 따른다.
- [ ] REST response body는 `{ schemaVersion: 1, provenance, payload }` envelope로 cache에 저장하되 header나 token은 저장하지 않는다.

### Cache

- [ ] cache key hash는 `fileKey`, `nodeId`, source kind, normalizer version을 포함하되 raw IDs를 디렉터리명으로 사용하지 않는다.
- [ ] cache file은 `.design-convergence/cache` 안에서만 private/atomic하게 쓴다.
- [ ] cache hit/miss provenance를 artifact에 기록한다.
- [ ] cache는 raw fixture를 바꾸지 않는다.

### Normalization

- [ ] RGBA float channel을 canonical `{ r, g, b, a }`로 변환한다.
- [ ] absolute bounds를 `box.x/y/width/height`로 변환한다.
- [ ] root-relative geometry를 계산한다.
- [ ] font weight name을 numeric weight로 변환한다.
- [ ] percent/absolute line height, letter spacing, font family/style/alignment을 canonical typography로 변환한다.
- [ ] Auto Layout direction/alignment/item spacing/padding과 clipping/overflow 근사를 변환한다.
- [ ] per-corner radius, strokes, fills/background image, opacity, drop/inner shadow, transform, image fit/position 중 REST가 제공하는 값을 canonical shape로 변환한다.
- [ ] 변환 불가능한 속성은 equal 처리하지 않고 unsupported record로 남긴다.
- [ ] 근사 변환은 `approximation: true`와 reason을 남긴다.

### Candidate selection

- [ ] root frame은 포함한다.
- [ ] component/instance root, image, standalone control, named region은 의미 있는 candidate로 포함한다.
- [ ] text node는 포함한다.
- [ ] auto layout frame과 fill/border/radius/shadow/padding/gap이 있는 container는 포함한다.
- [ ] invisible node와 zero-size node는 제외한다.
- [ ] pure organizational group은 제외한다.
- [ ] vector path internals, empty wrappers, mask implementation layer는 제외 또는 absorb한다.
- [ ] decorative rectangle은 parent에 absorb하고 `absorbedNodeIds`를 기록하며 가능한 fill/border/shadow를 parent appearance에 합친다.
- [ ] unsupported feature는 candidate에서 삭제하지 않고 reportable metadata로 남긴다.

### Manual binding

- [ ] `design-bindings.json` schema를 `@design-convergence/shared`에 둔다.
- [ ] binding은 `schemaVersion: 1`을 요구한다.
- [ ] `caseIds`, `figma.fileKey`, `figma.nodeId`, `source.filePath`, `runtime.attributeName`, `runtime.attributeValue`, `status`를 검증한다.
- [ ] v0.1 manual binding은 `status: validated`가 아니라 `proposed` 또는 `review-required`에서 시작한다.
- [ ] source preflight 통과는 별도 validation artifact에 기록하며 binding status를 `validated`로 올리지 않는다.

### Source preflight

- [ ] source file 존재를 검증한다.
- [ ] source path가 project root 밖으로 나가지 않는지 검증한다.
- [ ] binding value 중복을 거부한다.
- [ ] 동일 case에서 같은 Figma node를 충돌 binding으로 중복 매핑하면 거부한다.
- [ ] source range가 파일 범위를 벗어나거나 저장된 source hash와 다르면 stale binding으로 거부한다.
- [ ] target JSX node의 실제 identity/occurrence 검증은 Phase 03 Babel AST transform과 합쳐 완료한다.
- [ ] preflight 통과 binding만 Phase 03의 static instrumentation validation 입력이 될 수 있다.

## 테스트 우선 절차

1. `pricing-card.raw.json` fixture를 먼저 만든다.
2. normalized output의 핵심 필드만 explicit assertion으로 검증한다.
   - `designNodeId`
   - `box.height`
   - `layout.padding.left`
   - `appearance.background`
   - `appearance.radius`
   - `typography.fontSize`
   - `typography.fontWeight`
   - `typography.color`
3. unsupported fixture를 추가하고 unsupported가 equal로 사라지지 않는지 테스트한다.
4. duplicate binding fixture를 추가하고 source preflight failure를 먼저 확인한다.
5. stale source range fixture를 추가하고 stale failure를 먼저 확인한다.
6. REST source는 실제 네트워크 없이 mock fetch로 status, auth, cache behavior만 테스트한다.

## 실제 검증 명령

Phase 02 구현 후 실행한다.

```bash
pnpm --filter @design-convergence/figma test
pnpm --filter @design-convergence/shared test
pnpm --filter design-convergence test
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

CLI smoke는 live token 없이 fixture mode로만 실행한다.

```bash
pnpm --filter design-convergence exec design-convergence extract-figma \
  --case pricing-desktop \
  --source fixture

pnpm design-convergence validate-bindings \
  --case pricing-desktop \
  --static-only
```

위 CLI 명령은 Phase 02 구현 전에는 실행할 수 없다.

## 종료 게이트

- Figma raw fixture에서 Pricing Card canonical node를 생성한다.
- REST fetch path는 mock으로 테스트되며 live token이 필요 없다.
- cache read/write가 project root 안에서만 동작한다.
- candidate selection이 root/text/meaningful container를 포함하고 decorative/empty/invisible node를 제외 또는 absorb한다.
- manual `design-bindings.json`이 schemaVersion과 provenance를 가진다.
- duplicate/stale/path traversal binding이 source preflight에서 실패한다.
- AI provider나 browser runtime 없이 모든 테스트가 통과한다.

## 다음 phase 진입 게이트

Phase 03은 source preflight 결과를 Babel instrumentation target으로 넘겨야 한다.

필요한 입력:

```text
normalized Figma artifact
candidate tree artifact
manual design-bindings.json
source preflight result
```

필요한 불변조건:

- production source는 아직 수정하지 않는다.
- `data-design-node`는 test-only transform에서만 주입한다.
- preflight 통과는 instrumentation 후보 자격일 뿐이다. Phase 04 runtime validation 전에는 design comparison이나 auto-patching의 trusted binding이 아니다.

## 의도적 보류

- 실제 Figma API pagination/rate-limit 고도화는 fixture path가 안정된 뒤 추가한다.
- 복잡한 SVG path, mesh gradient, masking chain 변환은 unsupported로 기록한다.
- AI binding proposal은 Phase 05 전까지 만들지 않는다.
- runtime validation은 Playwright와 DOM extraction이 생기는 Phase 04에서 구현한다.
- Tailwind/source attribution은 Phase 06에서 구현한다.
