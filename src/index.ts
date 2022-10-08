import fs from 'fs'
import path from 'path'
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
} from '@autorecord/manager'
import { getInfo, getStream } from './stream'
import axios from 'axios'
import { singleton } from './utils'

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

    // TODO: 弹幕录制

    const savePath = getSavePath({ owner, title }) + '.flv'
    const saveFolder = path.dirname(savePath)
    if (!fs.existsSync(saveFolder)) {
      fs.mkdirSync(saveFolder, { recursive: true })
    }

    const callback = (...args: unknown[]) => {
      console.log('cb', ...args)
    }
    // TODO: 主播重新开关播后原来的直播流地址会失效，这可能会导致录制出现问题，需要处理
    const command = createFFMPEGBuilder(stream.url)
      .outputOptions(
        '-user_agent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/73.0.3683.86 Safari/537.36',
        '-c',
        'copy',
        '-flvflags',
        'add_keyframe_index'
      )
      .output(savePath)
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

        //   // todo 在此处对长时间无frame时的情况做检查
        // }
      })
    command.run()

    const stop = singleton<RecordHandle['stop']>(async () => {
      this.state = 'stopping-record'
      // TODO: emit update event

      command.kill('SIGKILL')

      this.usedStream = undefined
      this.usedSource = undefined
      // TODO: other codes
      // TODO: emit update event

      this.recordHandle = undefined
      this.state = 'idle'
    })

    this.recordHandle = {
      stream: stream.name,
      source: stream.source,
      url: stream.url,
      savePath,
      stop,
    }

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
