import mitt from 'mitt'
import * as cheerio from 'cheerio'
import {
  Recorder,
  RecorderCreateOpts,
  RecorderProvider,
  createFFMPEGBuilder,
  RecordHandle,
  defaultFromJSON,
  defaultToJSON,
  genRecorderUUID,
  genRecordUUID,
  createRecordExtraDataController,
  Comment,
  GiveGift,
} from '@autorecord/manager'
import { getInfo, getStream } from './stream'
import axios from 'axios'
import { ensureFolderExist, singleton } from './utils'
import { createDYClient } from './dy_client'
import { giftMap } from './gift_map'

const requester = axios.create({
  timeout: 10e3,
})

function createRecorder(opts: RecorderCreateOpts): Recorder {
  const checkLiveStatusAndRecord = singleton<
    Recorder['checkLiveStatusAndRecord']
  >(async function ({ getSavePath }) {
    if (this.recordHandle != null) return this.recordHandle

    const { living, owner, title } = await getInfo(this.channelId)
    if (!living) return null

    this.state = 'recording'
    const {
      currentStream: stream,
      sources: availableSources,
      streams: availableStreams,
    } = await getStream({
      channelId: opts.channelId,
      quality: opts.quality,
      streamPriorities: opts.streamPriorities,
      sourcePriorities: opts.sourcePriorities,
    })
    this.availableStreams = availableStreams.map((s) => s.name)
    this.availableSources = availableSources.map((s) => s.name)
    this.usedStream = stream.name
    this.usedSource = stream.source
    // TODO: emit update event

    const savePath = getSavePath({ owner, title })

    // TODO: 之后可能要结合 disableRecordMeta 之类的来确认是否要创建文件。
    const extraDataSavePath = savePath + '.json'
    // TODO: 这个 ensure 或许应该放在 createRecordExtraDataController 里实现？
    ensureFolderExist(extraDataSavePath)
    const extraDataController =
      createRecordExtraDataController(extraDataSavePath)

    extraDataController.setMeta({ title })

    const client = createDYClient(Number(opts.channelId), {
      notAutoStart: true,
    })
    client.on('message', (msg) => {
      switch (msg.type) {
        case 'chatmsg':
          const comment: Comment = {
            type: 'comment',
            timestamp: Date.now(),
            text: msg.txt,
            sender: {
              uid: msg.uid,
              name: msg.nn,
              avatar: msg.ic,
              extra: {
                level: msg.level,
              },
            },
          }
          this.emit('Message', comment)
          extraDataController.addMessage(comment)
          break

        case 'dgb':
          const gift: GiveGift = {
            type: 'give_gift',
            timestamp: Date.now(),
            name: giftMap[msg.gfid]?.name ?? '未知礼物',
            count: Number(msg.gfcnt),
            sender: {
              uid: msg.uid,
              name: msg.nn,
              avatar: msg.ic,
              extra: {
                level: msg.level,
              },
            },
            extra: {
              hits: Number(msg.hits),
            },
          }
          this.emit('Message', gift)
          extraDataController.addMessage(gift)
          break

        // TODO: 还有一些其他礼物相关的 msg 要处理，目前先简单点只处理 dgb
      }
    })
    if (!this.disableProvideCommentsWhenRecording) {
      client.start()
    }

    const recordSavePath = savePath + '.flv'
    ensureFolderExist(recordSavePath)

    const callback = (...args: unknown[]) => {
      console.log('cb', ...args)
    }
    // TODO: 主播重新开关播后原来的直播流地址会失效，这可能会导致录制出现问题，需要处理。
    const command = createFFMPEGBuilder(stream.url)
      .outputOptions(
        '-user_agent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/73.0.3683.86 Safari/537.36',
        '-c',
        'copy',
        '-flvflags',
        'add_keyframe_index'
      )
      .output(recordSavePath)
      .on('error', callback)
      .on('end', () => callback())
      .on('stderr', (stderrLine) => {
        console.error(`FFMPEG [${this.channelId}]:`, stderrLine)

        // if (stderrLine.startsWith('frame=')) {
        //   if (waitFirstFrame) {
        //     waitFirstFrame = false
        //     // 发出通知
        //     if (config.record.notice && !isSwitching)
        //       createNotice(channel.profile, channelInfo.title)
        //   }

        //   // TODO: 在此处对长时间无frame时的情况做检查。
        // }
      })
    command.run()
    extraDataController.setMeta({ recordStartTimestamp: Date.now() })

    const stop = singleton<RecordHandle['stop']>(async () => {
      if (!this.recordHandle) return
      this.state = 'stopping-record'
      // TODO: emit update event

      // 如果给 SIGKILL 信号会非正常退出，那么录制结束时应该应用的 add_keyframe_index 就会被跳过。
      // TODO: fluent-ffmpeg 好像没处理好这个 SIGINT 导致的退出信息，会抛一个错。
      command.kill('SIGINT')
      // TODO: 这里可能会有内存泄露，因为事件还没清，之后再检查下看看。
      client.stop()
      extraDataController.flush()

      this.usedStream = undefined
      this.usedSource = undefined
      // TODO: other codes
      // TODO: emit update event

      this.emit('RecordStop', this.recordHandle)
      this.recordHandle = undefined
      this.state = 'idle'
    })

    this.recordHandle = {
      id: genRecordUUID(),
      stream: stream.name,
      source: stream.source,
      url: stream.url,
      savePath: recordSavePath,
      stop,
    }
    this.emit('RecordStart', this.recordHandle)

    return this.recordHandle
  })

  const recorder: Recorder = {
    id: opts.id ?? genRecorderUUID(),
    ...mitt(),
    ...opts,

    availableStreams: [],
    availableSources: [],
    state: 'idle',

    getChannelURL() {
      return `https://www.douyu.com/${this.channelId}`
    },
    checkLiveStatusAndRecord,

    toJSON() {
      return defaultToJSON(provider, this)
    },
  }

  return recorder
}

export const provider: RecorderProvider = {
  id: 'DouYu',
  name: '斗鱼',
  siteURL: 'https://douyu.com/',

  matchURL(channelURL) {
    return /https?:\/\/(?:.*?\.)?douyu.com\//.test(channelURL)
  },

  async resolveChannelInfoFromURL(channelURL) {
    if (!this.matchURL(channelURL)) return null

    channelURL = channelURL.trim()
    const res = await requester.get(channelURL)
    const html = res.data
    const $ = cheerio.load(html)

    const scriptNode: any = $('script')
      .map((i, tag) => tag.children[0])
      .filter((i, tag: any) => tag.data.includes('$ROOM'))[0]
    if (!scriptNode) return null
    const matched = scriptNode.data.match(/\$ROOM\.room_id.?=(.*?);/)
    if (!matched) return null

    return {
      id: matched[1].trim(),
      title: $('.Title-header').text(),
      owner: $('.Title-anchorName').text(),
    }
  },

  createRecorder(opts) {
    return createRecorder({ providerId: provider.id, ...opts })
  },

  fromJSON(recorder) {
    return defaultFromJSON(this, recorder)
  },
}
