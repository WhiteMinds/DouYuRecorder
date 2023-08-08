/**
 * 本来打算直接用 douyudm 这个库，但有比较多的地方不符合我的需求，
 * 所以参考着这个库以及斗鱼的代码进行了重新实现。
 * reference: https://github.com/flxxyz/douyudm
 */
import WebSocket from 'ws'
import mitt, { Emitter } from 'mitt'
import { BufferCoder } from './buffer_coder'
import { STT } from './stt'

interface Message$Chat {
  type: 'chatmsg'
  gid: string // 弹幕组 id
  rid: string // 房间 id
  uid: string // 发送者 uid
  nn: string // 发送者昵称
  txt: string // 弹幕文本内容
  cid: string // 弹幕唯一 ID
  level: string // 用户等级
  gt: string // 礼物头衔: 默认值 0（表示没有头衔）
  col: string // 颜色: 默认值 0（表示默认颜色弹幕）
  ct: string // 客户端类型: 默认值 0（表示 web 用户）
  rg: string // 房间权限组: 默认值 1（表示普通权限用户）
  pg: string // 平台权限组: 默认值 1（表示普通权限用户）
  dlv: string // 酬勤等级: 默认值 0（表示没有酬勤）
  dc: string // 酬勤数量: 默认值 0（表示没有酬勤数量）
  bdlv: string // 最高酬勤等级: 默认值 0（表示全站都没有酬勤）
  ic: string // 头像地址
}

interface Message$Gift {
  type: 'dgb'
  rid: string // 房间 ID
  gid: string // 弹幕分组 ID
  gfid: string // 礼物 id
  gs: string // 礼物显示样式
  uid: string // 用户 id
  nn: string // 用户昵称
  str: string // 用户战斗力
  level: string // 用户等级
  dw: string // 主播体重
  gfcnt: string // 礼物个数:默认值 1(表示 1 个礼物)
  hits: string // 礼物连击次数:默认值 1(表示 1 连击)
  dlv: string // 酬勤头衔:默认值 0(表示没有酬勤)
  dc: string // 酬勤个数:默认值 0(表示没有酬勤数量)
  bdl: string // 全站最高酬勤等级:默认值 0(表示全站都没有酬勤)
  rg: string // 房间身份组:默认值 1(表示普通权限用户)
  pg: string // 平台身份组:默认值 1(表示普通权限用户)
  rpid: string // 红包 id:默认值 0(表示没有红包)
  slt: string // 红包开启剩余时间:默认值 0(表示没有红包)
  elt: string // 红包销毁剩余时间:默认值 0(表示没有红包)
  ic: string // 头像地址
  bnn: string // 用户牌子名？
}

export type Message = Message$Chat | Message$Gift

export interface DYClient
  extends Emitter<{
    message: Message
  }> {
  start: () => void
  stop: () => void
  send: (message: Record<string, unknown>) => void
}

export function createDYClient(
  channelId: number,
  opts: {
    notAutoStart?: boolean
  } = {},
): DYClient {
  let ws: WebSocket | null = null
  let coder = new BufferCoder()
  let heartbeatTimer: NodeJS.Timer | null = null

  const send = (message: Record<string, unknown>) => ws?.send(coder.encode(STT.serialize(message)))

  const sendLogin = () => send({ type: 'loginreq', roomid: channelId })
  const sendJoinGroup = () => send({ type: 'joingroup', rid: channelId, gid: -9999 })
  const sendHeartbeat = () => send({ type: 'mrkl' })
  const sendLogout = () => send({ type: 'logout' })

  const onOpen = () => {
    sendLogin()
    sendJoinGroup()
    heartbeatTimer = setInterval(sendHeartbeat, 45e3)
  }

  const onClose = () => {
    sendLogout()
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  const onError = (err: unknown) => {
    console.error(err)
    // TODO: 自动重连
  }

  const onMessage = (message: unknown) => {
    if (typeof message != 'object' || message == null || !('type' in message)) {
      console.warn('Unexpected message format', { message })
      return
    }

    client.emit(
      'message',
      // TODO: 不太好验证 schema，先强制转了
      message as Message,
    )
  }

  const start = () => {
    if (ws != null) return

    ws = new WebSocket(getRandomPortWSURL())
    coder = new BufferCoder()

    ws.binaryType = 'arraybuffer'
    ws.on('open', onOpen)
    ws.on('error', onError)
    ws.on('close', onClose)
    ws.on('message', (data) => {
      if (!(data instanceof ArrayBuffer)) {
        throw new Error('Do not meet the types of ws.binaryType expected')
      }

      coder.decode(data, (messageText) => {
        const message = STT.deserialize(messageText)
        onMessage(message)
      })
    })
  }

  const stop = () => {
    if (ws == null) return

    onClose()
    ws = null
  }

  if (!opts.notAutoStart) {
    start()
  }

  const client: DYClient = {
    ...mitt(),
    start,
    stop,
    send,
  }

  return client
}

function getRandomPortWSURL(): string {
  const port = 8500 + ((min, max) => Math.floor(Math.random() * (max - min + 1) + min))(1, 6)
  return `wss://danmuproxy.douyu.com:${port}/`
}
