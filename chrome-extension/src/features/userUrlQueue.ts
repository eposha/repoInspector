import { Octokit } from '@octokit/core';
import { initOctokit } from './octokit';
import { api } from './api';
import { auth } from './authentication';
import { initToken, timeout } from './utils';
import { downloaderStore } from './store/downloader';
import { historyStore } from './store/history';
import { DOWNLOADER_MODEL, Queue, STAGE } from './store/models';
import { NOTIFICATION_TYPES, notificationStore } from './store/notification';
import { userStore } from './store/user';

const LOCATION_REQUEST_THROTTLE = 1000;
const REQUEST_THROTTLE_NO_LOCATION = 300;
const STORAGE_WRITE_THROTTLE = 100;
const SYNC_THROTTLE = 5;
const NOMINATIM_LOCATION_API_Q =
  'https://nominatim.openstreetmap.org/search.php?format=jsonv2&addressdetails=1&q=';
let octokit: Octokit;

initToken().then((token) => {
  octokit = initOctokit(token);
});

class UserUrlQueue {
  downloader: Downloader;

  interval: null | ReturnType<typeof setInterval>;

  queue: Queue;

  constructor() {
    this.queue = new Queue();
    this.interval = null;
    this.downloader = DOWNLOADER_MODEL;
  }

  _saveQueueState() {
    // save queue state for when service worker resets
    const QUEUE_STATE = {
      items: this.queue.items,
      headIndex: this.queue.headIndex,
      tailIndex: this.queue.tailIndex,
      downloader: this.downloader,
      userDb: userStore.userDb,
    };
    chrome.storage.local.set({ QUEUE_STATE });
  }

  loadQueueState() {
    // load queue state for when service worker resets
    return new Promise((resolve) => {
      chrome.storage.local.get(async ({ QUEUE_STATE }) => {
        if (QUEUE_STATE) {
          this.queue.items = QUEUE_STATE.items;
          this.queue.headIndex = QUEUE_STATE.headIndex;
          this.queue.tailIndex = QUEUE_STATE.tailIndex;
          this.downloader = QUEUE_STATE.downloader;
          userStore.userDb = QUEUE_STATE.userDb;
          resolve(true);
        } else {
          resolve(false);
        }
      });
    });
  }

  _clearQueueState() {
    chrome.storage.local.remove(['QUEUE_STATE']);
  }

  async _storeQueueProgress() {
    // the popover is not in the same scope as the background job, so we save data to storage for front end display
    const downloader = await downloaderStore.get();

    if (downloader.active) {
      downloader.progress = {
        current: this.queue.headIndex,
        max: this.queue.tailIndex,
      };
      await downloaderStore.set(downloader);
    }
  }

  setQueueProgress() {
    // set progress of collecting url data from user urls.
    // In order to display progress on the client side we must write the progress to storage from the background job.
    // To limit writing to the storage too often (it can crash the extension) we only write to the storage once every STORAGE_WRITE_THROTTLE
    if (this.queue.length <= 1 || this.queue.length % SYNC_THROTTLE === 0) {
      this._storeQueueProgress();
      if (
        this.queue.length <= 1 ||
        this.queue.length % STORAGE_WRITE_THROTTLE === 0 ||
        this.queue.tailIndex === 0
      )
        this._saveQueueState();
    }
  }

  async getLocation(location: string) {
    // using a geocoding API, get location data for a given string
    const r = await fetch(`${NOMINATIM_LOCATION_API_Q}${location}`);

    return r.json();
  }

  async storeUserData(userData: any, type: string, userUrl: string) {
    const resultData: any = {};

    // get location data from the github location str
    if (userData.location && this.downloader.settings?.location) {
      try {
        const locationData = await this.getLocation(userData.location);

        resultData.country = locationData[0]?.address?.country;
        resultData.lat = locationData[0]?.lat;
        resultData.lon = locationData[0]?.lon;
      } catch (error) {
        console.log(error);
      }
    }

    // get user event count
    const { data } = await octokit.request(
      `GET ${userData.url}/events?per_page=100`,
    );
    resultData.event_count = data.length;

    // define real user
    resultData.real_user = userData.event_count > 3 || userData.followers > 3;

    // define active user
    const yearAgo = new Date(
      new Date().setFullYear(new Date().getFullYear() - 1),
    ).getTime();
    resultData.active_user =
      data.length &&
      data[0]?.created_at &&
      new Date(data[0]?.created_at).getTime() > yearAgo;

    // save user data
    userStore.set(type, userUrl, { ...userData, ...resultData });
    this.setQueueProgress();
  }

  async getUser(type: string, userUrl: string) {
    const { data } = await octokit.request(`GET ${userUrl}`);
    this.storeUserData(data, type, userUrl);
  }

  async runGetUser() {
    // only continue if repo hasn't been deleted
    this.downloader = await downloaderStore.get();

    if (!this.downloader.active) {
      this.deactivateInterval();
      this.queue = new Queue();

      return;
    }

    if (this.queue.length) {
      // if there are items in the queue, fetch them
      const currentQuery = this.queue.dequeue();
      this.getUser(currentQuery.type, currentQuery.userUrl);
    } else {
      this.deactivateInterval();
      // allow any other request to finish
      timeout(10000);
      // eslint-disable-next-line
      this._finishInspection();
    }
  }

  async _finishInspection() {
    // on finish inspection we deactivate the interval and send the data to the server for packaging and emailing it.
    this.deactivateInterval();
    const downloader = await downloaderStore.get();

    const userData = userStore.userDb;
    const postData = {
      repository: downloader,
      forks: Object.values(userData.forks),
      stargazers: Object.values(userData.stargazers),
    };

    try {
      const data = await api.post(
        `repository/?user_id=${auth.currentUser.uuid}`,
        postData,
      );

      downloader.stage = STAGE.DONE;
      downloader.id = data.id;

      notificationStore.set({
        type: NOTIFICATION_TYPES.SUCCESS,
        message: 'Nice! Your repo data has been sent to your email.',
      });
    } catch (error) {
      alert(error);
      downloader.stage = STAGE.ERROR;
    }

    // save data to history
    await historyStore.set(downloader);
    userStore.refresh();
    await downloaderStore.reset();
  }

  async run() {
    this._saveQueueState();

    const downloader = await downloaderStore.get();
    downloader.stage = STAGE.GETTING_USERS;
    await downloaderStore.set(downloader);

    this.downloader = downloader;

    if (!this.interval) {
      let throttle = REQUEST_THROTTLE_NO_LOCATION;

      if (downloader.settings.location) {
        throttle = LOCATION_REQUEST_THROTTLE;
      }

      this.interval = setInterval(() => {
        this.runGetUser();
      }, throttle);
    }
  }

  deactivateInterval() {
    // reset the queue and clear the interval.
    this.queue = new Queue();

    this._clearQueueState();

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async continueFromSave() {
    if (!this.interval) {
      this.run();
    }
  }
}

export const userUrlQueue = new UserUrlQueue();
