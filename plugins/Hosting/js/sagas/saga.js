import { takeEvery } from 'redux-saga'
import { put, take, fork } from 'redux-saga/effects'
import * as actions from '../actions/actions.js'
import * as constants from '../constants/constants.js'
import * as helper from '../utils/host.js'
import { Map, List } from 'immutable'
import BigNumber from 'bignumber.js'

// siadCall: promisify Siad API calls.  Resolve the promise with `response` if the call was successful,
// otherwise reject the promise with `err`.
const siadCall = (uri) => new Promise((resolve, reject) => {
	SiaAPI.call(uri, (err, response) => {
		if (err) {
			reject(err)
		} else {
			resolve(response)
		}
	})
})

const fetchStorageFiles = () => new Promise((resolve, reject) => {
	siadCall({
		url: '/host/storage',
		method: 'GET',
	}).then((fetchedFiles) => {
		resolve(List((fetchedFiles.folders || []).map((file) => (
			Map({
				path: file.path,
				size: (new BigNumber(file.capacity)).times('1e-9').toString(),
				free: (new BigNumber(file.capacityremaining)).times('1e-9').toString(),
			})
		))))
	}).catch(reject)
})

function *announceHost(action) {
	try {
		yield put( actions.showAnnounceDialog(action.address) )
		const closeAction = yield take( constants.HIDE_ANNOUNCE_DIALOG )
		if (closeAction.address !== '') { //If size is zero just hide the dialog.
			yield siadCall({
				url: '/host/announce',
				timeout: 30000, // 30 second timeout for host announcement
				method: 'POST',
				qs: { netaddress: closeAction.address },
			})
		}
	} catch (e) {
		SiaAPI.showError({ title: 'Error Announcing Host', content: e.message })
	}
}

function *addFolder(action) {
	try {
		yield siadCall({
			url: '/host/storage/folders/add',
			method: 'POST',
			qs: {
				path: action.folder.get('path'),
				size: action.folder.get('size'), //Is given in GB.
			},
		})
		yield put( actions.fetchData() )
	} catch (e) {
		SiaAPI.showError({ title: 'Error Adding Folder', content: e.message })
	}
}

function *addFolderAskPathSize() {
	const newLocation = helper.chooseFileLocation()
	if (newLocation) {
		try {
			yield put( actions.showResizeDialog(Map({ path: newLocation, size: 50 }), true) )
			const closeAction = yield take( constants.HIDE_RESIZE_DIALOG )
			if (closeAction.folder.get('size')) {
				yield put( actions.addFolder(Map({
					path: newLocation,
					size: (new BigNumber(closeAction.folder.get('size'))).times(new BigNumber('1e9')).toString(),
				})) )
			}
		} catch (e) {
			SiaAPI.showError({ title: 'Error Adding Folder', content: e.message })
		}
	}
}

function *removeFolder(action) {
	try {
		yield siadCall({
			url: '/host/storage/folders/remove',
			method: 'POST',
			qs: {
				path: action.folder.get('path'),
			},
		})
		yield put( actions.fetchData() )
	} catch (e) {
		SiaAPI.showError({ title: 'Error Removing Folder', content: e.message })
	}
}

function *resizeFolder(action) {
	try {
		yield put( actions.showResizeDialog(action.folder, action.ignoreInitial) )
		const closeAction = yield take( constants.HIDE_RESIZE_DIALOG )
		if (closeAction.folder.get('size')) { //If size is zero just hide the dialog.
			yield siadCall({
				url: '/host/storage/folders/resize',
				method: 'POST',
				qs: {
					path: closeAction.folder.get('path'),
					newsize: (new BigNumber(closeAction.folder.get('size'))).times('1e9').toString(),
				},
			})
			yield put( actions.fetchData() )
		}
	} catch (e) {
		SiaAPI.showError({ title: 'Error Resizing Folder', content: e.message })
	}
}

function *pushSettings(action) {
	try {
		yield siadCall({
			url: '/host',
			method: 'POST',
			qs: {
				'acceptingcontracts': action.settings.get('acceptingContracts'),
				'maxduration': helper.weeksToBlocks(action.settings.get('maxduration')).toString(),
				'collateral':
					helper.SCTBMonthToHastingsByteBlock(action.settings.get('collateral')).toString(),
				'minstorageprice':
					helper.SCTBMonthToHastingsByteBlock(action.settings.get('storageprice')).toString(), //bytes->TB, blocks -> month
				'mindownloadbandwidthprice':
					helper.SCTBToHastingsByte(action.settings.get('downloadbandwidthprice')).toString(),
			},
		})
		yield put( actions.fetchData() )
	} catch (e) {
		SiaAPI.showError({ title: 'Error Updating Settings', content: e.message })
	}
}

const parseSettings = (hostData) => Map({
	maxduration: helper.blocksToWeeks(hostData.externalsettings.maxduration).toFixed(0),
	collateral: helper.hastingsByteBlockToSCTBMonth(hostData.externalsettings.collateral).toFixed(0),
	storageprice: helper.hastingsByteBlockToSCTBMonth(hostData.externalsettings.storageprice).toFixed(0),
	downloadbandwidthprice: helper.hastingsByteToSCTB(hostData.externalsettings.downloadbandwidthprice).toString(),
	acceptingContracts: hostData.externalsettings.acceptingcontracts,
})

function *fetchData() {
	try {
		const updatedData = yield siadCall({ url: '/host' })
		const walletUnlocked = yield siadCall({ url: '/wallet' })

		const data = Map({
			numContracts: updatedData.financialmetrics.contractcount,
			storage: (new BigNumber(updatedData.externalsettings.totalstorage)).minus(new BigNumber(updatedData.externalsettings.remainingstorage)).toString(),
			earned: SiaAPI.hastingsToSiacoins(updatedData.financialmetrics.contractcompensation).toString(),
			expected: SiaAPI.hastingsToSiacoins(updatedData.financialmetrics.potentialcontractcompensation).toString(),
			files: yield fetchStorageFiles(),
			walletLocked: !walletUnlocked.unlocked,
			walletsize: walletUnlocked.confirmedsiacoinbalance,
		})

		const modals = Map({
			defaultAnnounceAddress: updatedData.externalsettings.netaddress,
		})

		const settings = parseSettings(updatedData)

		yield put( actions.fetchDataSuccess(data, settings, modals) )
	} catch (e) {
		console.error('error fetching host data: ' + e.toString())
	}
}

function *requestDefaultSettingsSaga() {
	try {
		const hostData = yield siadCall('/host')
		yield put(actions.receiveDefaultSettings(parseSettings(hostData)))
	} catch (e) {
		console.error('error fetching defaults: ' + e.toString())
	}
}

function *pushSettingsListener() {
	yield *takeEvery(constants.PUSH_SETTINGS, pushSettings)
}
function *fetchSettingsListener() {
	yield *takeEvery(constants.FETCH_DATA, fetchData)
}
function *addFolderListener() {
	yield *takeEvery(constants.ADD_FOLDER, addFolder)
}
function *addFolderAskListener() {
	yield *takeEvery(constants.ADD_FOLDER_ASK, addFolderAskPathSize)
}
function *removeFolderListener() {
	yield *takeEvery(constants.REMOVE_FOLDER, removeFolder)
}
function *resizeFolderListener() {
	yield *takeEvery(constants.RESIZE_FOLDER, resizeFolder)
}
function *announceHostListener() {
	yield *takeEvery(constants.ANNOUNCE_HOST, announceHost)
}
function *requestDefaultsListener() {
	yield *takeEvery(constants.REQUEST_DEFAULT_SETTINGS, requestDefaultSettingsSaga)
}

export default function *initSaga() {
	yield [
		fork(pushSettingsListener),
		fork(fetchSettingsListener),
		fork(addFolderListener),
		fork(addFolderAskListener),
		fork(removeFolderListener),
		fork(resizeFolderListener),
		fork(announceHostListener),
		fork(requestDefaultsListener),
	]
}
