/* -*- Mode: js2; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */

var EXPORTED_SYMBOLS = [ "firetray", "FLDRS_UNINTERESTING" ];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

Cu.import("resource:///modules/mailServices.js");
Cu.import("resource://gre/modules/PluralForm.jsm");
Cu.import("resource://firetray/commons.js");

const FLDRS_UNINTERESTING = {
  Archive:   Ci.nsMsgFolderFlags.Archive,
  Drafts:    Ci.nsMsgFolderFlags.Drafts,
  Junk:      Ci.nsMsgFolderFlags.Junk,
  Queue:     Ci.nsMsgFolderFlags.Queue,
  SentMail:  Ci.nsMsgFolderFlags.SentMail,
  Templates: Ci.nsMsgFolderFlags.Templates,
  Trash:     Ci.nsMsgFolderFlags.Trash
};


firetray.Messaging = {
  initialized: false,

  init: function() {
    if (this.initialized) {
      WARN("Messaging already initialized");
      return;
    }
    LOG("Enabling Messaging");

    let that = this;
    MailServices.mailSession.AddFolderListener(that.mailSessionListener,
                                               that.mailSessionListener.notificationFlags);

    this.initialized = true;
  },

  shutdown: function() {
    if (!this.initialized)
      return;
    LOG("Disabling Messaging");

    MailServices.mailSession.RemoveFolderListener(this.mailSessionListener);
    firetray.Handler.setIconImageDefault();

    this.initialized = false;
  },

  /**
   * http://mxr.mozilla.org/comm-central/source/mailnews/base/public/nsIFolderListener.idl
   */
  mailSessionListener: {
    notificationFlags:
      // Ci.nsIFolderListener.propertyChanged |
      // Ci.nsIFolderListener.propertyFlagChanged |
      // Ci.nsIFolderListener.event |
      Ci.nsIFolderListener.boolPropertyChanged |
      Ci.nsIFolderListener.intPropertyChanged,

    OnItemPropertyChanged: function(item, property, oldValue, newValue) { // NumNewBiffMessages
      LOG("OnItemPropertyChanged "+property+" for folder "+item.prettyName+" was "+oldValue+" became "+newValue+" NEW MESSAGES="+item.getNumNewMessages(true));
    },

    OnItemIntPropertyChanged: function(item, property, oldValue, newValue) { // TotalUnreadMessages, BiffState (per server)
      LOG("OnItemIntPropertyChanged "+property+" for folder "+item.prettyName+" was "+oldValue+" became "+newValue+" NEW MESSAGES="+item.getNumNewMessages(true));
      this.updateMsgCount(item, property, oldValue, newValue);
    },

    OnItemBoolPropertyChanged: function(item, property, oldValue, newValue) { // NewMessages (per folder)
      LOG("OnItemBoolPropertyChanged "+property+" for folder "+item.prettyName+" was "+oldValue+" became "+newValue+" NEW MESSAGES="+item.getNumNewMessages(true));
      this.updateMsgCount(item, property, oldValue, newValue);
    },

    OnItemPropertyFlagChanged: function(item, property, oldFlag, newFlag) {
      LOG("OnItemPropertyFlagChanged"+property+" for "+item+" was "+oldFlag+" became "+newFlag);
    },

    OnItemEvent: function(item, event) {
      LOG("OnItemEvent"+event+" for folder "+item.prettyName);
    },

    updateMsgCount: function(item, property, oldValue, newValue) {
      let excludedFoldersFlags = firetray.Utils.prefService.getIntPref("excluded_folders_flags");
      let msgCountType = firetray.Utils.prefService.getIntPref("message_count_type");
      LOG("msgCountType="+msgCountType);

      if (!(item.flags & excludedFoldersFlags)) {
        let prop = property.toString();
        if (msgCountType === FIRETRAY_MESSAGE_COUNT_TYPE_UNREAD &&
            prop === "TotalUnreadMessages") {
          firetray.Messaging.updateMsgCount();
        } else if (msgCountType === FIRETRAY_MESSAGE_COUNT_TYPE_NEW &&
                   prop === "NewMessages") {
          if (oldValue === true && newValue === false)
            item.setNumNewMessages(0); // https://bugzilla.mozilla.org/show_bug.cgi?id=727460
          firetray.Messaging.updateMsgCount();
        }
      }
    }
  },

  /**
   * computes and display new msg count
   */
  updateMsgCount: function() {
    LOG("updateMsgCount");
    if (!this.initialized)
      return;

    let newMsgCount = this.countMessages();

    // update icon
    if (newMsgCount == 0) {
      firetray.Handler.setIconImageDefault();
      firetray.Handler.setIconTooltipDefault();

    } else if (newMsgCount > 0) {
      let prefMailNotification = firetray.Utils.prefService.getIntPref('mail_notification_type');
      switch (prefMailNotification) {
      case FIRETRAY_NOTIFICATION_UNREAD_MESSAGE_COUNT:
        let prefIconTextColor = firetray.Utils.prefService.getCharPref("icon_text_color");
        firetray.Handler.setIconText(newMsgCount.toString(), prefIconTextColor);
        break;
      case FIRETRAY_NOTIFICATION_NEWMAIL_ICON:
        firetray.Handler.setIconImage(firetray.StatusIcon.themedIconNewMail);
        break;
      case FIRETRAY_NOTIFICATION_CUSTOM_ICON:
        let prefCustomIconPath = firetray.Utils.prefService.getCharPref("custom_mail_icon");
        firetray.Handler.setIconImageFromFile(prefCustomIconPath);
        break;
      default:
        ERROR("Unknown notification mode: "+prefMailNotification);
      }

      let localizedMessage = PluralForm.get(
        newMsgCount,
        firetray.Utils.strings.GetStringFromName("tooltip.unread_messages"))
        .replace("#1", newMsgCount);;
      firetray.Handler.setIconTooltip(localizedMessage);

    } else {
      throw "negative message count"; // should never happen
    }

  },

  /**
   * computes total unread message count.
   * NOTE: new messages can(?) be filtered and mark read, but still be
   * considered new, so we may have to use nsMsgFolderFlagType.GotNew on all
   * folders
   */
  countMessages: function() {
    let msgCountType = firetray.Utils.prefService.getIntPref("message_count_type");
    LOG("msgCountType="+msgCountType);
    if (msgCountType === FIRETRAY_MESSAGE_COUNT_TYPE_UNREAD) {
      folderCountFunctionName = 'getNumUnread';
    } else if (msgCountType === FIRETRAY_MESSAGE_COUNT_TYPE_NEW) {
      folderCountFunctionName = 'getNumNewMessages'; // perfectly bogus if > 0
    } else
      ERROR('unknown message count type');

    let mailAccounts = firetray.Utils.getObjPref('mail_accounts');
    LOG("mail accounts from pref: "+JSON.stringify(mailAccounts));
    let serverTypes = mailAccounts["serverTypes"];
    let excludedAccounts = mailAccounts["excludedAccounts"];
    let excludedFoldersFlags = firetray.Utils.prefService
      .getIntPref("excluded_folders_flags");

    let newMsgCount = 0;
    try {
      let accounts = new this.Accounts();
      for (let accountServer in accounts) {
        LOG("is servertype excluded: "+serverTypes[accountServer.type].excluded+", account exclusion index: "+excludedAccounts.indexOf(accountServer.key));
        if ( (serverTypes[accountServer.type].excluded)
          || (excludedAccounts.indexOf(accountServer.key) >= 0) )
          continue;

        let rootFolder = accountServer.rootFolder; // nsIMsgFolder
        if (rootFolder.hasSubFolders) {
          let subFolders = rootFolder.subFolders; // nsIMsgFolder
          while(subFolders.hasMoreElements()) {
            let folder = subFolders.getNext().QueryInterface(Ci.nsIMsgFolder);
            if (!(folder.flags & excludedFoldersFlags)) {
              let folderNewMsgCount = folder[folderCountFunctionName](true); // includes subfolders
              LOG(folder.prettyName+" "+folderCountFunctionName+"="+folderNewMsgCount);
              newMsgCount += folderNewMsgCount;
            }
          }
        }
      }
    } catch (x) {
      ERROR(x);
    }
    LOG("Total Unread="+newMsgCount);
    return newMsgCount;
  }

};


/**
 * Accounts Iterator/Generator for iterating over account servers
 * @param sortByTypeAndName: boolean
 */
firetray.Messaging.Accounts = function(sortByTypeAndName) {
  if (typeof(sortByTypeAndName) == "undefined") {
    this.sortByTypeAndName = false;
    return;
  }
  if (typeof(sortByTypeAndName) !== "boolean")
    throw new TypeError();

  this.sortByTypeAndName = sortByTypeAndName;
};
firetray.Messaging.Accounts.prototype.__iterator__ = function() {
  let accounts = MailServices.accounts.accounts;
  LOG("sortByTypeAndName="+this.sortByTypeAndName);

  /* NOTE: sort() not provided by nsIMsgAccountManager.accounts
   (nsISupportsArray, nsICollection). Should be OK to re-build a JS-Array for
   few accounts */
  let accountServers = [];
  for (let i=0, len=accounts.Count(); i<len; ++i) {
    let account = accounts.QueryElementAt(i, Ci.nsIMsgAccount);
    let accountServer = account.incomingServer;
    accountServers[i] = accountServer;
  }

  let mailAccounts = firetray.Utils.getObjPref('mail_accounts');
  let serverTypes = mailAccounts["serverTypes"];
  if (this.sortByTypeAndName) {
    accountServers.sort(function(a,b) {
      if (serverTypes[a.type].order
          < serverTypes[b.type].order)
        return -1;
      if (serverTypes[a.type].order
          > serverTypes[b.type].order)
        return 1;
      if (a.prettyName < b.prettyName)
        return -1;
      if (a.prettyName > b.prettyName)
        return 1;
      return 0; // no sorting
    });
  }

  for (let i=0, len=accountServers.length; i<len; ++i) {
    LOG("ACCOUNT: "+accountServers[i].prettyName+" type: "+accountServers[i].type);
    yield accountServers[i];
  }
};

/**
 * return accounts grouped by mail_accounts.
 *
 * ex: { movemail: {"server1", "server2"}, imap: {"server3"} }
 */
firetray.Messaging.accountsByServerType = function() {
  let accountsByServerType = {};
  let accounts = new firetray.Messaging.Accounts(false);
  for (let accountServer in accounts) {
    let accountServerKey = accountServer.key.toString();
    let accountServerName = accountServer.prettyName;
    let accountServerType = accountServer.type;
    if (typeof(accountsByServerType[accountServerType]) == "undefined")
      accountsByServerType[accountServerType] = [];
    accountsByServerType[accountServerType].push(
      { key: accountServerKey, name: accountServerName });
  }
  return accountsByServerType;
};
