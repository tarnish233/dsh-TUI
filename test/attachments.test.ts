import assert from 'node:assert/strict'
import test from 'node:test'
import { asImageAttachmentRef, displayContentParts, imageAttachmentKey, imageAttachmentValue, imageAttachments, imageMediaTypeFromBytes, sameImageAttachment } from '../src/attachments.ts'
import { imageFixture } from './helpers/images.ts'

for (const mediaType of ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const) {
  test(`parent attachment transport: verifies ${mediaType} shape and exact base64 bytes`, async () => {
    const fixture = await imageFixture(mediaType)
    assert.equal(imageMediaTypeFromBytes(fixture.bytes), mediaType)
    assert.deepEqual(imageAttachmentValue(fixture.value, fixture.attachment), fixture.value)
    assert.deepEqual(asImageAttachmentRef(fixture.attachment), fixture.attachment)
  })
}

test('parent attachment projection: keeps mixed order and repeated image occurrences', async () => {
  const fixture = await imageFixture()
  const blocks = [{ type: 'text', text: 'before' }, { type: 'image', attachment: fixture.attachment },
    { type: 'text', text: 'between' }, { type: 'image', attachment: fixture.attachment }, { type: 'text', text: 'after' }]
  assert.deepEqual(displayContentParts(blocks), blocks)
  assert.equal(imageAttachments(blocks).length, 2)
  assert.deepEqual(displayContentParts([{ type: 'image', data: fixture.value.data, mimeType: 'image/png' }]), [], 'legacy inline test shapes are not fake durable references')
})

test('parent attachment transport: malformed references never become filesystem paths', async () => {
  const { attachment } = await imageFixture()
  for (const bad of [null, [], {}, { ...attachment, bytes: 0 }, { ...attachment, width: 0 },
    { ...attachment, height: NaN }, { ...attachment, mediaType: 'image/svg+xml' },
    { ...attachment, attachmentId: '' }, { ...attachment, name: {} },
    { ...attachment, originalDimensions: { width: 0, height: 20 } }]) {
    assert.equal(asImageAttachmentRef(bad), undefined)
  }
  const opaque = { ...attachment, attachmentId: 'not-a-host-path-or-url' }
  assert.equal(asImageAttachmentRef(opaque)?.attachmentId, opaque.attachmentId, 'only native DSH decides integrity/identifier validity')
})

test('parent attachment transport: rejects truncation, noncanonical base64 and ref mismatch', async () => {
  const { value, attachment } = await imageFixture()
  for (const data of [value.data.slice(0, -4), value.data + '\n', '!'.repeat(value.data.length), '', 'YQ==']) {
    assert.throws(() => imageAttachmentValue({ attachment, data }, attachment), /attachment response/i)
  }
  for (const altered of [{ ...attachment, width: attachment.width + 1 }, { ...attachment, attachmentId: 'other' },
    { ...attachment, mediaType: 'image/jpeg' as const }, { ...attachment, bytes: attachment.bytes + 1 }]) {
    assert.throws(() => imageAttachmentValue({ ...value, attachment: altered }, attachment), /attachment response/i)
  }
})

test('parent attachment cache identity: metadata mismatch cannot hit previously verified bytes', async () => {
  const { attachment } = await imageFixture()
  assert.equal(sameImageAttachment(attachment, { ...attachment, name: 'renamed' }), true)
  assert.equal(imageAttachmentKey(attachment), imageAttachmentKey({ ...attachment, name: 'renamed' }))
  assert.notEqual(imageAttachmentKey(attachment), imageAttachmentKey({ ...attachment, width: attachment.width + 1 }))
  assert.notEqual(imageAttachmentKey(attachment), imageAttachmentKey({ ...attachment, bytes: attachment.bytes + 1 }))
})
