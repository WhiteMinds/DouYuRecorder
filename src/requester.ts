import axios from 'axios'

export const requester = axios.create({
  timeout: 10e3,
})
