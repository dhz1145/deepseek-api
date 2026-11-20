import { useRef, useState, type ChangeEvent } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { setAccountProfile, useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import { ProfileAvatar } from './ProfileAvatar.js'
import styles from './AccountProfile.module.css'

const MAX_AVATAR_EDGE = 256
const MAX_USERNAME_LENGTH = 40

const prepareAvatar = async (file: File) => {
  const url = URL.createObjectURL(file)
  const image = new Image()
  try {
    image.src = url
    await image.decode()
    const { naturalWidth: width, naturalHeight: height } = image
    const crop = Math.min(width, height)
    const edge = Math.min(crop, MAX_AVATAR_EDGE)
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = edge
    const context = canvas.getContext('2d')
    if (!context || edge === 0) {
      throw new Error('Unable to resize avatar')
    }
    context.imageSmoothingQuality = 'high'
    context.drawImage(image, (width - crop) / 2, (height - crop) / 2, crop, crop, 0, 0, edge, edge)
    const avatar = canvas.toDataURL('image/webp', 0.85)
    if (avatar === 'data:,') {
      throw new Error('Unable to encode avatar')
    }
    return avatar
  } finally {
    URL.revokeObjectURL(url)
  }
}

export const ProfileEditor = () => {
  const t = useTranslate()
  const saved = useSettings((state) => state.accountProfile)
  const [username, setUsername] = useState(saved.username)
  const [avatar, setAvatar] = useState(saved.avatar)
  const [loadingAvatar, setLoadingAvatar] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const changed = username.trim() !== saved.username || avatar !== saved.avatar

  const chooseAvatar = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) {
      return
    }
    setLoadingAvatar(true)
    try {
      setAvatar(await prepareAvatar(file))
    } catch {
      showToast({ key: 'profileAvatarInvalid', type: 'error' })
    } finally {
      setLoadingAvatar(false)
    }
  }

  return (
    <form
      className={styles.editor}
      onSubmit={(event) => {
        event.preventDefault()
        if (!changed || loadingAvatar) {
          return
        }
        const name = username.trim()
        if (setAccountProfile({ username: name, avatar })) {
          setUsername(name)
          showToast({ key: 'profileSaved' })
        } else {
          showToast({ key: 'profileSaveFailed', type: 'error' })
        }
      }}
    >
      <div className={styles.avatarField} aria-busy={loadingAvatar}>
        <ProfileAvatar src={avatar} />
        <div className={styles.avatarActions}>
          <Button
            size="m"
            variant="outlined"
            disabled={loadingAvatar}
            onClick={() => input.current?.click()}
          >
            {t(avatar ? 'profileChangeAvatar' : 'profileChooseAvatar')}
          </Button>
          {avatar ? (
            <Button
              size="m"
              variant="outlined"
              disabled={loadingAvatar}
              onClick={() => setAvatar(null)}
            >
              {t('profileRemoveAvatar')}
            </Button>
          ) : null}
        </div>
        <input ref={input} type="file" accept="image/*" hidden onChange={chooseAvatar} />
      </div>
      <label className={styles.usernameField}>
        {t('profileUsername')}
        <input
          type="text"
          autoComplete="nickname"
          maxLength={MAX_USERNAME_LENGTH}
          placeholder={t('profileDefaultUsername')}
          value={username}
          onChange={(event) => setUsername(event.currentTarget.value)}
        />
      </label>
      <Button size="m" type="submit" disabled={!changed || loadingAvatar}>
        {t('profileSave')}
      </Button>
    </form>
  )
}
