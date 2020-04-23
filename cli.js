#!/usr/bin/env node

const { argv } = require('yargs')
  .scriptName('wrtc-agent')
  .options({
    'c': {
      alias: 'client-id',
      demandOption: true,
      description: 'Client id for mqtt-client',
      type: 'string'
    },
    'n': {
      alias: 'name',
      demandOption: true,
      description: 'Conference app name',
      type: 'string'
    },
    'P': {
      alias: 'password',
      demandOption: true,
      description: 'Password for mqtt-client',
      type: 'string'
    },
    'r': {
      alias: 'room-id',
      demandOption: true,
      description: 'Conference room id',
      type: 'string'
    },
    'relay-only': {
      description: 'Use only "relay" ICE candidates',
      type: 'boolean'
    },
    'stun': {
      demandOption: true,
      description: 'STUN server URL',
      type: 'string'
    },
    'turn': {
      demandOption: true,
      description: 'TURN server URL',
      type: 'string'
    },
    'turn-password': {
      demandOption: true,
      description: 'TURN password',
      type: 'string'
    },
    'turn-username': {
      demandOption: true,
      description: 'TURN username',
      type: 'string'
    },
    'u': {
      alias: 'uri',
      demandOption: true,
      description: 'MQTT broker URI',
      type: 'string'
    },
  })
  .help()

// console.log('[argv]', argv)

const { createClient, enterRoom } = require('./lib/mqtt')
const { Peer, transformOffer } = require('./lib/peer')

// args
const {
  clientId,
  name: appName,
  password,
  roomId,
  relayOnly,
  stun,
  turn,
  turnPassword,
  turnUsername,
  uri
} = argv

const iceServers = [
  { urls: stun },
  {
    urls: turn,
    username: turnUsername,
    credential: turnPassword,
  },
]
const iceTransportPolicy = relayOnly ? 'relay' : 'all'

let activeRtcStream = null
let peer = null

function listRtcStreamAll (client, roomId) {
  const LIST_LIMIT = 25
  const now = Math.round(Date.now() / 1000)
  let result = []
  let counter = 0

  function loop (room, offset, cb) {
    client.listRtcStream(room, { offset, time: [now, null] })
      .then((response) => {
        if (response.length > 0) {
          counter += 1

          result = result.concat(response)

          if (response.length === LIST_LIMIT) {
            loop(room, counter * LIST_LIMIT, cb)
          } else {
            counter = 0

            cb()
          }
        } else {
          cb()
        }
      })
      .catch((error) => {
        cb(error)
      })
  }

  return new Promise((resolve, reject) => {
    loop(roomId, 0, (error) => {
      if (error) {
        reject(error)

        return
      }

      resolve(result)
    })
  })
}

function startListening (client, activeRtcStream) {
  const activeRtcId = activeRtcStream.rtc_id
  const listenerOptions = { offerToReceiveVideo: true, offerToReceiveAudio: true }

  let handleId = null

  peer = new Peer(
    { iceServers, iceTransportPolicy },
    candidateObj => {
      const { candidate, completed, sdpMid, sdpMLineIndex } = candidateObj

      client.createRtcSignal(handleId, completed ? candidateObj : { candidate, sdpMid, sdpMLineIndex })
        .catch(error => console.debug('[startListening] error', error))
    },
    (track, streams) => {
      console.debug('[track]', track.kind)
    },
  )

  // setInterval(() => {
  //   peer.__peer.getStats()
  //     .then(report => console.log('[getStats]', report))
  // }, 5000)

  client.connectRtc(activeRtcId)
    .then((response) => {
      handleId = response.handle_id

      return peer.createOffer(listenerOptions)
    })
    .then(offer => {
      const newOffer = transformOffer(offer)

      return client.createRtcSignal(handleId, newOffer)
        .then((response) => ({ response, offer: newOffer }))
    })
    .then(({ response, offer }) => {
      return peer.setOffer(offer)
        .then(() => peer.setAnswer(response.jsep))
    })
    .catch(error => console.debug('[startListening] error', error))
}

function stopListening () {
  if (peer) {
    peer.close()

    peer = null
  }
}

createClient({ appName, clientId, password, uri })
  .then(({ conferenceClient }) => {
    function isStreamActive (stream) {
      const { time } = stream

      return Boolean(time && time.length > 0 && time[0] !== null && time[1] === null)
    }

    function isStreamEnded (stream) {
      const { time } = stream

      return Boolean(time && time.length > 0 && time[0] !== null && time[1] !== null)
    }

    function handleStream (stream) {
      if (!activeRtcStream && isStreamActive(stream)) {
        activeRtcStream = stream

        startListening(conferenceClient, activeRtcStream)
      } else if (activeRtcStream && stream && activeRtcStream.id === stream.id && isStreamEnded(stream)) {
        activeRtcStream = null

        stopListening()
      } else {
        // do nothing
      }
    }

    conferenceClient.on('rtc_stream.update', (event) => {
      const { id, rtc_id, sent_by, time } = event.data

      console.group(`[event:${event.type}]`)
      console.log('[id]', id)
      console.log('[rtc_id]', rtc_id)
      console.log('[sent_by]', sent_by)
      console.log('[time]', time)
      console.groupEnd()

      handleStream(event.data)
    })

    enterRoom(conferenceClient, roomId, clientId)
      .then(() => {
        console.log('[READY]')

        listRtcStreamAll(conferenceClient, roomId)
          .then((response) => {
            console.log('[listRtcStream] response', response)

            if (response.length > 0 && isStreamActive(response[0])) {
              handleStream(response[0])
            }
          })
          .catch(error => console.log('[listRtcStreamAll] error', error))
      })
  })