import { v4 as uuid4 } from 'uuid'
import MD5 from 'crypto-js/md5'
import { VM } from 'vm2'
import * as queryString from 'query-string'
import { requester } from './requester'

/**
 * 对斗鱼 getH5Play 接口的封装
 */
export async function getLiveInfo(opts: {
  channelId: string
  cdn?: string
  rate?: number
  rejectSignFnCache?: boolean
}): Promise<
  | {
      living: false
    }
  | {
      living: true
      sources: GetH5PlaySuccessData['cdnsWithName']
      streams: GetH5PlaySuccessData['multirates']
      isSupportRateSwitch: boolean
      isOriginalStream: boolean
      currentStream: {
        source: string
        name: string
        rate: number
        url: string
      }
    }
> {
  const sign = await getSignFn(opts.channelId, opts.rejectSignFnCache)
  const did = uuid4().replace(/-/g, '')
  const time = Math.ceil(Date.now() / 1000)
  // TODO: 这里类型处理的有点问题，先用 as 顶着
  const signed = queryString.parse(sign(opts.channelId, did, time)) as Record<string, string>

  // TODO: 以后可以试试换成 https://open.douyu.com/source/api/9 里提供的公开接口，
  // 不过公开接口可能会存在最高码率的限制。
  const res = await requester.post<
    | {
        data: GetH5PlaySuccessData
        error: number
        msg: string
      }
    | string
  >(
    `https://www.douyu.com/lapi/live/getH5Play/${opts.channelId}`,
    new URLSearchParams({
      ...signed,
      cdn: opts.cdn ?? '',
      // 相当于清晰度类型的 id，给 -1 会由后端决定
      rate: String(opts.rate ?? -1),
    }),
  )

  if (res.status !== 200) {
    if (res.status === 403 && res.data === '鉴权失败' && !opts.rejectSignFnCache) {
      // 使用非缓存的sign函数再次签名
      return getLiveInfo({ ...opts, rejectSignFnCache: true })
    }

    throw new Error(`Unexpected status code, ${res.status}, ${res.data}`)
  }

  // TODO: assert data not string
  if (typeof res.data === 'string') throw new Error()

  let json = res.data
  // 不存在的房间、已被封禁、未开播
  if ([-3, -4, -5].includes(json.error)) return { living: false }
  // 其他
  if (json.error !== 0) {
    // 时间戳错误，目前不确定原因，但重新获取几次 sign 函数可解决。
    // TODO: 这里与 getSignFn 隐式的耦合了
    if (json.error === -9) delete signCaches[opts.channelId]

    throw new Error('Unexpected error code, ' + json.error)
  }

  return {
    living: true,
    sources: json.data.cdnsWithName,
    streams: json.data.multirates,
    isSupportRateSwitch: json.data.rateSwitch === 1,
    isOriginalStream: json.data.rateSwitch !== 1,
    currentStream: {
      source: json.data.rtmp_cdn,
      name:
        json.data.rateSwitch !== 1
          ? '原画'
          : json.data.multirates.find(({ rate }) => rate === json.data.rate)?.name ?? '未知',
      rate: json.data.rate,
      url: `${json.data.rtmp_url}/${json.data.rtmp_live}`,
    },
  }
}

// 斗鱼为了判断是否是浏览器环境，会在 sign 过程中去验证一些 window / document 上的函数
// 是否是 native 的，这里利用 proxy 来模拟。
const disguisedNativeMethods = new Proxy(
  {},
  {
    get: function (target, name) {
      return 'function () { [native code] }'
    },
  },
)

type SignFunction = (channelId: string, did: string, time: number) => string
const signCaches: Record<string, SignFunction> = {}

async function getSignFn(address: string, rejectCache?: boolean): Promise<SignFunction> {
  if (!rejectCache && signCaches.hasOwnProperty(address)) {
    // 有缓存, 直接使用
    return signCaches[address]
  }

  let res = await requester.get('https://www.douyu.com/swf_api/homeH5Enc?rids=' + address)
  const json = res.data
  if (json.error !== 0) throw new Error('Unexpected error code, ' + json.error)
  let code = json.data && json.data['room' + address]
  if (!code) throw new Error('Unexpected result with homeH5Enc, ' + JSON.stringify(json))

  const vm = new VM({
    sandbox: {
      CryptoJS: { MD5 },
      window: disguisedNativeMethods,
      document: disguisedNativeMethods,
    },
  })
  let sign = vm.run(code + ';ub98484234')
  signCaches[address] = sign

  return sign
}

export interface SourceProfile {
  name: string
  cdn: string
  isH265: true
}

export interface StreamProfile {
  name: string
  rate: number
  highBit: number
  bit: number
  diamondFan: number
}

interface GetH5PlaySuccessData {
  room_id: number
  is_mixed: false
  mixed_live: string
  mixed_url: string
  rtmp_cdn: string
  rtmp_url: string
  rtmp_live: string
  client_ip: string
  inNA: number
  rateSwitch: number
  rate: number
  cdnsWithName: SourceProfile[]
  multirates: StreamProfile[]
  isPassPlayer: number
  eticket: null
  online: number
  mixedCDN: string
  p2p: number
  streamStatus: number
  smt: number
  p2pMeta: unknown
  p2pCid: number
  p2pCids: string
  player_1: string
  h265_p2p: number
  h265_p2p_cid: number
  h265_p2p_cids: string
  acdn: string
  av1_url: string
  rtc_stream_url: string
  rtc_stream_config: string
}
