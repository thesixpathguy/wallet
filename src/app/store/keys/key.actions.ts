import { AddressVersion } from '@stacks/transactions';

import { decryptMnemonic, encryptMnemonic } from '@shared/crypto/mnemonic-encryption';
import { logger } from '@shared/logger';
import { InternalMethods } from '@shared/message-types';
import { sendMessage } from '@shared/messages';

import { recurseAccountsForActivity } from '@app/common/account-restoration/account-restore';
import { checkForLegacyGaiaConfigWithKnownGeneratedAccountIndex } from '@app/common/account-restoration/legacy-gaia-config-lookup';
import { BitcoinClient } from '@app/query/bitcoin/bitcoin-client';
import { StacksClient } from '@app/query/stacks/stacks-client';
import { AppThunk } from '@app/store';

import { getNativeSegwitAddressFromMnemonic } from '../accounts/blockchain/bitcoin/bitcoin-keychain';
import { getStacksAddressByIndex } from '../accounts/blockchain/stacks/stacks-keychain';
import { stxChainSlice } from '../chains/stx-chain.slice';
import { selectDefaultWalletKey } from '../in-memory-key/in-memory-key.selectors';
import { inMemoryKeySlice } from '../in-memory-key/in-memory-key.slice';
import { selectCurrentKey } from './key.selectors';
import { defaultKeyId, keySlice } from './key.slice';

function setWalletEncryptionPassword(args: {
  password: string;
  stxClient: StacksClient;
  btcClient: BitcoinClient;
}): AppThunk {
  const { password, stxClient, btcClient } = args;

  return async (dispatch, getState) => {
    const secretKey = selectDefaultWalletKey(getState());
    if (!secretKey) throw new Error('Cannot generate wallet without first having generated a key');
    const { encryptedSecretKey, salt } = await encryptMnemonic({ secretKey, password });

    const legacyAccountActivityLookup =
      await checkForLegacyGaiaConfigWithKnownGeneratedAccountIndex(secretKey);

    async function doesStacksAddressHaveBalance(address: string) {
      const resp = await stxClient.accountsApi.getAccountBalance({ principal: address });
      return Number(resp.stx.balance) > 0;
    }

    async function doesStacksAddressHaveBnsName(address: string) {
      const resp = await stxClient.namesApi.getNamesOwnedByAddress({
        address,
        blockchain: 'stacks',
      });
      return resp.names.length > 0;
    }

    async function doesBitcoinAddressHaveBalance(address: string) {
      const resp = await btcClient.addressApi.getUtxosByAddress(address);
      return resp.length > 0;
    }

    // Performs a recursive check for account activity. When activity is found
    // at a higher index than what is found on Gaia (long-term wallet users), we
    // update the highest known account index that the wallet generates. This
    // action is performed outside this Promise's execution, as it may be slow,
    // and the user shouldn't have to wait before being directed to homepage.
    logger.info('Initiating recursive account activity lookup');
    void recurseAccountsForActivity({
      async doesAddressHaveActivityFn(index) {
        const stxAddress = getStacksAddressByIndex(
          secretKey,
          AddressVersion.MainnetSingleSig
        )(index);
        const hasStxBalance = await doesStacksAddressHaveBalance(stxAddress);
        const hasNames = await doesStacksAddressHaveBnsName(stxAddress);

        const btcAddress = getNativeSegwitAddressFromMnemonic(secretKey)(index);
        const hasBtcBalance = await doesBitcoinAddressHaveBalance(btcAddress.address!);
        // TODO: add inscription check here also?
        return hasStxBalance || hasNames || hasBtcBalance;
      },
    }).then(recursiveActivityIndex => {
      if (recursiveActivityIndex <= legacyAccountActivityLookup) return;
      logger.info('Found account activity at higher index', { recursiveActivityIndex });
      dispatch(stxChainSlice.actions.restoreAccountIndex(recursiveActivityIndex));
    });

    sendMessage({
      method: InternalMethods.ShareInMemoryKeyToBackground,
      payload: { secretKey, keyId: defaultKeyId },
    });

    dispatch(inMemoryKeySlice.actions.setKeysInMemory({ default: secretKey }));
    dispatch(
      keySlice.actions.createStacksSoftwareWalletComplete({
        type: 'software',
        id: defaultKeyId,
        salt,
        encryptedSecretKey,
      })
    );
    if (legacyAccountActivityLookup !== 0)
      dispatch(stxChainSlice.actions.restoreAccountIndex(legacyAccountActivityLookup));
  };
}

function unlockWalletAction(password: string): AppThunk {
  return async (dispatch, getState) => {
    const currentKey = selectCurrentKey(getState());
    if (!currentKey) return;
    if (currentKey.type !== 'software') return;
    const { secretKey } = await decryptMnemonic({ password, ...currentKey });
    sendMessage({
      method: InternalMethods.ShareInMemoryKeyToBackground,
      payload: { secretKey: secretKey, keyId: defaultKeyId },
    });
    dispatch(inMemoryKeySlice.actions.setKeysInMemory({ default: secretKey }));
  };
}

export const keyActions = { ...keySlice.actions, setWalletEncryptionPassword, unlockWalletAction };
