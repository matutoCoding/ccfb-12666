import './ui/styles.css'
import { App } from './ui/app'
import { loadInitialState, replaceState } from './state/store'

const root = document.getElementById('app')!

loadInitialState().then(loaded => {
  replaceState(loaded)
  new App(root)
})
