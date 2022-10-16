import * as cheerio from 'cheerio'
import axios from 'axios'
import { Qualities, Recorder } from '@autorecord/manager'
import { getLiveInfo, SourceProfile, StreamProfile } from './dy_api'
import * as R from 'ramda'
import { getValuesFromArrayLikeFlexSpaceBetween } from './utils'

const requester = axios.create({
  timeout: 10e3,
})

export async function getInfo(channelId: string): Promise<{
  living: boolean
  owner: string
  title: string
  startTime: Date
  gifts: {
    id: string
    name: string
    img: string
    cost: number
  }[]
}> {
  const res = await requester.get<
    | {
        error: number
        data: {
          room_status: string
          owner_name: string
          avatar: string
          room_name: string
          start_time: string
          gift: {
            id: string
            name: string
            himg: string
            pc: number
          }[]
        }
      }
    | string
  >(`http://open.douyucdn.cn/api/RoomApi/room/${channelId}`)

  if (res.status !== 200) {
    if (res.status === 404 && res.data === 'Not Found') {
      throw new Error('错误的地址 ' + channelId)
    }

    throw new Error(`Unexpected status code, ${res.status}, ${res.data}`)
  }

  if (typeof res.data !== 'object')
    throw new Error(`Unexpected response, ${res.status}, ${res.data}`)

  const json = res.data
  if (json.error === 101) throw new Error('错误的地址 ' + channelId)
  if (json.error !== 0) throw new Error('Unexpected error code, ' + json.error)

  let living = json.data.room_status === '1'
  if (living) {
    const res = await requester.get<string>(
      `https://www.douyu.com/${channelId}`
    )
    const isVideoLoop = res.data.includes('"videoLoop":1,')
    if (isVideoLoop) {
      living = false
    }
  }

  return {
    living,
    owner: json.data.owner_name,
    title: json.data.room_name,
    startTime: new Date(json.data.start_time),
    gifts: json.data.gift.map((g) => ({
      id: g.id,
      name: g.name,
      img: g.himg,
      cost: g.pc,
    })),
  }
}

export async function getStream(
  opts: Pick<
    Recorder,
    'channelId' | 'quality' | 'streamPriorities' | 'sourcePriorities'
  > & { rejectCache?: boolean }
) {
  let liveInfo = await getLiveInfo({
    channelId: opts.channelId,
    cdn: opts.sourcePriorities[0],
  })
  if (!liveInfo.living) throw new Error()

  let expectStream: StreamProfile | null = null
  const streamsWithPriority = sortAndFilterStreamsByPriority(
    liveInfo.streams,
    opts.streamPriorities
  )
  if (streamsWithPriority.length > 0) {
    // 通过优先级来选择对应流
    expectStream = streamsWithPriority[0]
  } else {
    // 通过设置的画质选项来选择对应流
    const isHighestAsExpected =
      opts.quality === 'highest' && liveInfo.isOriginalStream
    if (!isHighestAsExpected) {
      const streams = getValuesFromArrayLikeFlexSpaceBetween(
        // 斗鱼给的画质列表是按照清晰到模糊的顺序的，这里翻转下
        R.reverse(liveInfo.streams),
        Qualities.length
      )
      expectStream = streams[Qualities.indexOf(opts.quality)]
    }
  }

  let expectSource: SourceProfile | null = null
  const sourcesWithPriority = sortAndFilterSourcesByPriority(
    liveInfo.sources,
    opts.sourcePriorities
  )
  if (sourcesWithPriority.length > 0) {
    expectSource = sourcesWithPriority[0]
  }

  if (
    (expectStream != null &&
      liveInfo.currentStream.rate !== expectStream.rate) ||
    (expectSource != null &&
      liveInfo.currentStream.source !== expectSource.name)
  ) {
    // 当前流不是预期的流或源，需要切换。
    // TODO: 这一步可能会导致原画的流被切走并且没法再取得，需要额外进行提示。
    if (!liveInfo.isSupportRateSwitch) {
      // TODO: 无法切换
    } else {
      liveInfo = await getLiveInfo({
        channelId: opts.channelId,
        rate: expectStream?.rate,
        cdn: expectSource?.name,
      })
      if (!liveInfo.living) throw new Error()
    }
  }

  // 流未准备好，防止刚开播时的无效录制。
  // 该判断可能导致开播前 30 秒左右无法录制到，因为 streamStatus 在后端似乎有缓存，所以暂时不使用。
  // TODO: 需要在 ffmpeg 那里加处理，防止无效录制
  // if (!json.data.streamStatus) return

  return liveInfo
}

/**
 * 按提供的流优先级去给流列表排序，并过滤掉不在优先级配置中的流
 */
function sortAndFilterStreamsByPriority(
  streams: StreamProfile[],
  streamPriorities: Recorder['streamPriorities']
): (StreamProfile & {
  priority: number
})[] {
  if (streamPriorities.length === 0) return []

  return R.sortBy(
    R.prop('priority'),
    // 分配优先级属性，数字越大优先级越高
    streams
      .map((stream) => ({
        ...stream,
        priority: R.reverse(streamPriorities).indexOf(stream.name),
      }))
      .filter(({ priority }) => priority !== -1)
  )
}

/**
 * 按提供的源优先级去给源列表排序，并过滤掉不在优先级配置中的源
 */
function sortAndFilterSourcesByPriority(
  sources: SourceProfile[],
  sourcePriorities: Recorder['sourcePriorities']
): (SourceProfile & {
  priority: number
})[] {
  if (sourcePriorities.length === 0) return []

  return R.sortBy(
    R.prop('priority'),
    // 分配优先级属性，数字越大优先级越高
    sources
      .map((source) => ({
        ...source,
        priority: R.reverse(sourcePriorities).indexOf(source.name),
      }))
      .filter(({ priority }) => priority !== -1)
  )
}
