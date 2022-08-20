// execute in shell `ts-node src/test.ts` to run test
// TODO: add to scripts
import { createRecorderManager } from '@autorecord/manager'
import { provider } from '.'

const manager = createRecorderManager()
manager.loadRecorderProvider(provider)
manager.addRecorder(provider.id, {
  channelId: '74751',
  quality: 'highest',
  streamPriorities: [],
  sourcePriorities: [],
})
manager.startCheckLoop()
